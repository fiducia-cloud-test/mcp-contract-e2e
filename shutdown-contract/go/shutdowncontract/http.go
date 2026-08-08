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

// Logger accepts fleet-standard structured fields without prescribing a
// logging package.
type Logger interface {
	Info(message string, fields map[string]any)
	Warn(message string, fields map[string]any)
	Error(message string, fields map[string]any)
}

type Config struct {
	GracePeriod time.Duration
	StdinIsTTY  bool
	Stdin       io.Reader
	Signals     <-chan os.Signal
	Flush       func(context.Context) error
}

type Outcome struct {
	Forced  bool
	Trigger Trigger
}

// WaitHTTP blocks until a shutdown event, drains with http.Server.Shutdown,
// and uses http.Server.Close only for the force path.
func WaitHTTP(parent context.Context, server *http.Server, logger Logger, cfg Config) (Outcome, error) {
	if cfg.GracePeriod <= 0 {
		cfg.GracePeriod = 30 * time.Second
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

	var first os.Signal
	select {
	case <-parent.Done():
		first = syscall.SIGTERM
	case first = <-signals:
	}

	trigger := triggerFromSignal(first)
	state := Apply(Initial(cfg.StdinIsTTY), trigger).State
	fields := fieldsFor(state, trigger, cfg.GracePeriod, false)
	logger.Info("graceful shutdown requested; listener is closing and active work is draining", fields)

	eof := make(chan struct{}, 1)
	if state.StdinIsTTY && trigger == SIGINT {
		logger.Info("press Ctrl-C again or Ctrl-D to force shutdown", map[string]any{
			"event":        "shutdown_force_available",
			"phase":        string(state.Phase),
			"trigger":      string(trigger),
			"stdin_is_tty": true,
			"grace_ms":     cfg.GracePeriod.Milliseconds(),
			"forced":       false,
		})
		// This reader is intentionally armed only after the first interactive
		// SIGINT, so it never steals application or stdio-protocol input.
		go waitForEOF(cfg.Stdin, eof)
	}

	shutdownDone := make(chan error, 1)
	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), cfg.GracePeriod)
	defer cancelShutdown()
	go func() { shutdownDone <- server.Shutdown(shutdownCtx) }()

	var outcome Outcome
	var shutdownErr error
	select {
	case err := <-shutdownDone:
		if errors.Is(err, context.DeadlineExceeded) {
			state = Apply(state, Timeout).State
			outcome = Outcome{Forced: true, Trigger: Timeout}
		} else {
			shutdownErr = normalizeHTTPServerError(err)
			state = Apply(state, GracefulComplete).State
			outcome = Outcome{Forced: false, Trigger: trigger}
		}
	case next := <-signals:
		forceTrigger := triggerFromSignal(next)
		state = Apply(state, forceTrigger).State
		outcome = Outcome{Forced: true, Trigger: forceTrigger}
	case <-eof:
		state = Apply(state, StdinEOF).State
		outcome = Outcome{Forced: true, Trigger: StdinEOF}
	case <-shutdownCtx.Done():
		state = Apply(state, Timeout).State
		outcome = Outcome{Forced: true, Trigger: Timeout}
	}

	if outcome.Forced {
		logger.Warn("forceful shutdown requested; active connections will be dropped", fieldsFor(state, outcome.Trigger, cfg.GracePeriod, true))
		shutdownErr = errors.Join(shutdownErr, normalizeHTTPServerError(server.Close()))
	}

	flushCtx, cancelFlush := context.WithTimeout(context.Background(), cfg.GracePeriod)
	defer cancelFlush()
	flushErr := cfg.Flush(flushCtx)
	combined := errors.Join(shutdownErr, flushErr)
	if combined != nil {
		logger.Error("shutdown cleanup failed", map[string]any{
			"event":        "shutdown_failed",
			"phase":        string(state.Phase),
			"trigger":      string(outcome.Trigger),
			"stdin_is_tty": state.StdinIsTTY,
			"grace_ms":     cfg.GracePeriod.Milliseconds(),
			"forced":       outcome.Forced,
			"error":        combined.Error(),
		})
		return outcome, combined
	}

	logger.Info("server shutdown complete", map[string]any{
		"event":        "shutdown_complete",
		"phase":        string(Complete),
		"trigger":      string(outcome.Trigger),
		"stdin_is_tty": state.StdinIsTTY,
		"grace_ms":     cfg.GracePeriod.Milliseconds(),
		"forced":       outcome.Forced,
	})
	return outcome, nil
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
	return map[string]any{
		"event":        event,
		"phase":        string(state.Phase),
		"trigger":      string(trigger),
		"stdin_is_tty": state.StdinIsTTY,
		"grace_ms":     grace.Milliseconds(),
		"forced":       forced,
	}
}
