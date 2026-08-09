package shutdowncontract

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

// Logger accepts fleet-standard structured fields without prescribing a logging package.
type Logger interface {
	Info(message string, fields map[string]any)
	Warn(message string, fields map[string]any)
	Error(message string, fields map[string]any)
}

type Config struct {
	GracePeriod time.Duration
	ForcePeriod time.Duration
	StdinIsTTY  bool
	Stdin       io.Reader
	Signals     <-chan os.Signal
	Flush       func(context.Context) error
}

type Outcome struct {
	Forced      bool
	Trigger     Trigger
	SignalCount int
}

type shutdownServer interface {
	Shutdown(context.Context) error
	Close() error
}

// WaitHTTP blocks until a shutdown event, drains with http.Server.Shutdown,
// and uses http.Server.Close only for the force path.
func WaitHTTP(parent context.Context, server *http.Server, logger Logger, cfg Config) (Outcome, error) {
	return waitHTTP(parent, server, logger, cfg)
}

func waitHTTP(parent context.Context, server shutdownServer, logger Logger, cfg Config) (Outcome, error) {
	if parent == nil {
		parent = context.Background()
	}
	if cfg.GracePeriod <= 0 {
		cfg.GracePeriod = 30 * time.Second
	}
	if cfg.ForcePeriod <= 0 {
		cfg.ForcePeriod = cfg.GracePeriod
		if cfg.ForcePeriod > 5*time.Second {
			cfg.ForcePeriod = 5 * time.Second
		}
	}
	if cfg.Stdin == nil {
		cfg.Stdin = os.Stdin
	}
	if cfg.Flush == nil {
		cfg.Flush = func(context.Context) error { return nil }
	}

	ownedSignals := make(chan os.Signal, 2)
	signals := cfg.Signals
	if signals == nil {
		signal.Notify(ownedSignals, os.Interrupt, syscall.SIGTERM)
		defer signal.Stop(ownedSignals)
		signals = ownedSignals
	}

	parentTriggered := false
	var first os.Signal
	select {
	case <-parent.Done():
		first = syscall.SIGTERM
		parentTriggered = true
	case value, ok := <-signals:
		if !ok {
			return Outcome{}, errors.New("shutdown signal source closed")
		}
		first = value
	}

	trigger := triggerFromSignal(first)
	state := Apply(Initial(cfg.StdinIsTTY), trigger).State
	if parentTriggered {
		state.SignalCount = 0
	}
	logger.Info(
		"graceful shutdown requested; listener is closing and active work is draining",
		fieldsFor(state, trigger, cfg.GracePeriod, false),
	)

	var eof <-chan struct{}
	if state.StdinIsTTY && trigger == SIGINT && !parentTriggered {
		logger.Info(
			"press Ctrl-C again or Ctrl-D to force shutdown",
			fieldsForEvent(state, trigger, cfg.GracePeriod, false, "shutdown_force_available"),
		)
		eofChannel := make(chan struct{}, 1)
		eof = eofChannel
		// Deliberately armed only after first interactive SIGINT.
		go waitForEOF(cfg.Stdin, eofChannel)
	}

	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), cfg.GracePeriod)
	defer cancelShutdown()
	shutdownDone := make(chan error, 1)
	go func() { shutdownDone <- server.Shutdown(shutdownCtx) }()

	outcome := Outcome{Trigger: trigger, SignalCount: state.SignalCount}
	var shutdownErr error
	select {
	case err := <-shutdownDone:
		normalized := normalizeHTTPServerError(err)
		switch {
		case errors.Is(err, context.DeadlineExceeded) || errors.Is(shutdownCtx.Err(), context.DeadlineExceeded):
			state = Apply(state, Timeout).State
			outcome = Outcome{Forced: true, Trigger: Timeout, SignalCount: state.SignalCount}
		case normalized != nil:
			shutdownErr = normalized
			state = Apply(state, DrainFailed).State
			outcome = Outcome{Forced: true, Trigger: DrainFailed, SignalCount: state.SignalCount}
		default:
			state = Apply(state, GracefulComplete).State
			outcome = Outcome{Forced: false, Trigger: trigger, SignalCount: state.SignalCount}
		}
	case next, ok := <-signals:
		if !ok {
			state = Apply(state, DrainFailed).State
			shutdownErr = errors.New("shutdown signal source closed while draining")
			outcome = Outcome{Forced: true, Trigger: DrainFailed, SignalCount: state.SignalCount}
			break
		}
		forceTrigger := triggerFromSignal(next)
		state = Apply(state, forceTrigger).State
		outcome = Outcome{Forced: true, Trigger: forceTrigger, SignalCount: state.SignalCount}
	case <-eof:
		state = Apply(state, StdinEOF).State
		outcome = Outcome{Forced: true, Trigger: StdinEOF, SignalCount: state.SignalCount}
	case <-shutdownCtx.Done():
		state = Apply(state, Timeout).State
		outcome = Outcome{Forced: true, Trigger: Timeout, SignalCount: state.SignalCount}
	}

	var cleanupCtx context.Context
	var cancelCleanup context.CancelFunc
	if outcome.Forced {
		cancelShutdown()
		logger.Warn(
			"forceful shutdown requested; active connections will be dropped",
			fieldsFor(state, outcome.Trigger, cfg.GracePeriod, true),
		)
		shutdownErr = errors.Join(shutdownErr, normalizeHTTPServerError(server.Close()))
		cleanupCtx, cancelCleanup = context.WithTimeout(context.Background(), cfg.ForcePeriod)
	} else {
		cleanupCtx = shutdownCtx
		cancelCleanup = func() {}
	}
	defer cancelCleanup()

	flushErr := runBounded(cleanupCtx, cfg.Flush)
	combined := errors.Join(shutdownErr, flushErr)
	if combined != nil {
		logger.Error(
			"shutdown cleanup failed",
			map[string]any{
				"event":        "shutdown_failed",
				"phase":        string(state.Phase),
				"trigger":      string(outcome.Trigger),
				"stdin_is_tty": state.StdinIsTTY,
				"signal_count": state.SignalCount,
				"grace_ms":     cfg.GracePeriod.Milliseconds(),
				"forced":       outcome.Forced,
				"error":        combined.Error(),
			},
		)
		return outcome, combined
	}

	logger.Info(
		"server shutdown complete",
		map[string]any{
			"event":        "shutdown_complete",
			"phase":        string(Complete),
			"trigger":      string(outcome.Trigger),
			"stdin_is_tty": state.StdinIsTTY,
			"signal_count": state.SignalCount,
			"grace_ms":     cfg.GracePeriod.Milliseconds(),
			"forced":       outcome.Forced,
		},
	)
	return outcome, nil
}

func runBounded(ctx context.Context, callback func(context.Context) error) error {
	done := make(chan error, 1)
	go func() { done <- callback(ctx) }()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

func waitForEOF(reader io.Reader, eof chan<- struct{}) {
	buffered := bufio.NewReader(reader)
	for {
		_, err := buffered.ReadByte()
		if errors.Is(err, io.EOF) {
			select {
			case eof <- struct{}{}:
			default:
			}
			return
		}
		if err != nil {
			return
		}
	}
}

func triggerFromSignal(signal os.Signal) Trigger {
	if signal == os.Interrupt || signal == syscall.SIGINT {
		return SIGINT
	}
	return SIGTERM
}

func normalizeHTTPServerError(err error) error {
	if err == nil || errors.Is(err, http.ErrServerClosed) || errors.Is(err, context.Canceled) {
		return nil
	}
	return err
}

func fieldsFor(state State, trigger Trigger, grace time.Duration, forced bool) map[string]any {
	event := "shutdown_requested"
	if forced {
		event = "shutdown_forced"
	}
	return fieldsForEvent(state, trigger, grace, forced, event)
}

func fieldsForEvent(state State, trigger Trigger, grace time.Duration, forced bool, event string) map[string]any {
	return map[string]any{
		"event":        event,
		"phase":        string(state.Phase),
		"trigger":      string(trigger),
		"stdin_is_tty": state.StdinIsTTY,
		"signal_count": state.SignalCount,
		"grace_ms":     grace.Milliseconds(),
		"forced":       forced,
	}
}
