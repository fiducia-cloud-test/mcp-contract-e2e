package shutdowncontract

import (
	"context"
	"errors"
	"io"
	"os"
	"sync"
	"syscall"
	"testing"
	"time"
)

type hardeningLogger struct{}

func (hardeningLogger) Info(string, map[string]any)  {}
func (hardeningLogger) Warn(string, map[string]any)  {}
func (hardeningLogger) Error(string, map[string]any) {}

type fakeHTTPShutdownServer struct {
	started     chan struct{}
	release     chan struct{}
	shutdownErr error
	closeCalls  int
	mu          sync.Mutex
}

func newFakeHTTPShutdownServer() *fakeHTTPShutdownServer {
	return &fakeHTTPShutdownServer{
		started: make(chan struct{}),
		release: make(chan struct{}),
	}
}

func (server *fakeHTTPShutdownServer) Shutdown(ctx context.Context) error {
	select {
	case <-server.started:
	default:
		close(server.started)
	}
	if server.shutdownErr != nil {
		return server.shutdownErr
	}
	select {
	case <-server.release:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (server *fakeHTTPShutdownServer) Close() error {
	server.mu.Lock()
	server.closeCalls++
	server.mu.Unlock()
	select {
	case <-server.release:
	default:
		close(server.release)
	}
	return nil
}

func (server *fakeHTTPShutdownServer) calls() int {
	server.mu.Lock()
	defer server.mu.Unlock()
	return server.closeCalls
}

type countingReader struct {
	reads int
	mu    sync.Mutex
}

func (reader *countingReader) Read([]byte) (int, error) {
	reader.mu.Lock()
	reader.reads++
	reader.mu.Unlock()
	return 0, io.EOF
}

func (reader *countingReader) count() int {
	reader.mu.Lock()
	defer reader.mu.Unlock()
	return reader.reads
}

func TestDrainErrorAlwaysEscalatesToClose(t *testing.T) {
	server := newFakeHTTPShutdownServer()
	server.shutdownErr = errors.New("drain failed")
	signals := make(chan os.Signal, 1)
	signals <- syscall.SIGTERM

	outcome, err := waitHTTP(context.Background(), server, hardeningLogger{}, Config{
		GracePeriod: time.Second,
		Signals:     signals,
	})
	if err == nil || !outcome.Forced || outcome.Trigger != DrainFailed || server.calls() != 1 {
		t.Fatalf("outcome=%#v err=%v close_calls=%d", outcome, err, server.calls())
	}
	if outcome.SignalCount != 1 {
		t.Fatalf("signal count=%d", outcome.SignalCount)
	}
}

func TestTTYSIGTERMDoesNotReadStdin(t *testing.T) {
	server := newFakeHTTPShutdownServer()
	reader := &countingReader{}
	signals := make(chan os.Signal, 1)
	result := make(chan Outcome, 1)
	errors := make(chan error, 1)
	go func() {
		outcome, err := waitHTTP(context.Background(), server, hardeningLogger{}, Config{
			GracePeriod: time.Second,
			StdinIsTTY:  true,
			Stdin:       reader,
			Signals:     signals,
		})
		result <- outcome
		errors <- err
	}()

	signals <- syscall.SIGTERM
	<-server.started
	time.Sleep(20 * time.Millisecond)
	if reader.count() != 0 {
		t.Fatalf("SIGTERM armed stdin reader: %d reads", reader.count())
	}
	close(server.release)
	outcome := <-result
	if err := <-errors; err != nil {
		t.Fatal(err)
	}
	if outcome.Forced || outcome.SignalCount != 1 {
		t.Fatalf("outcome=%#v", outcome)
	}
}

func TestNonTTYSignalNeverReadsStdin(t *testing.T) {
	server := newFakeHTTPShutdownServer()
	reader := &countingReader{}
	signals := make(chan os.Signal, 1)
	result := make(chan Outcome, 1)
	go func() {
		outcome, _ := waitHTTP(context.Background(), server, hardeningLogger{}, Config{
			GracePeriod: time.Second,
			StdinIsTTY:  false,
			Stdin:       reader,
			Signals:     signals,
		})
		result <- outcome
	}()

	signals <- os.Interrupt
	<-server.started
	close(server.release)
	outcome := <-result
	if reader.count() != 0 || outcome.Forced {
		t.Fatalf("reads=%d outcome=%#v", reader.count(), outcome)
	}
}

func TestFlushIgnoringContextIsBounded(t *testing.T) {
	server := newFakeHTTPShutdownServer()
	close(server.release)
	signals := make(chan os.Signal, 1)
	signals <- syscall.SIGTERM
	started := time.Now()
	outcome, err := waitHTTP(context.Background(), server, hardeningLogger{}, Config{
		GracePeriod: 25 * time.Millisecond,
		Signals:     signals,
		Flush: func(context.Context) error {
			select {}
		},
	})
	if err == nil || outcome.Forced {
		t.Fatalf("outcome=%#v err=%v", outcome, err)
	}
	if elapsed := time.Since(started); elapsed > 500*time.Millisecond {
		t.Fatalf("unbounded flush: %s", elapsed)
	}
}
