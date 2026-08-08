package shutdowncontract

import (
	"context"
	"io"
	"net"
	"net/http"
	"os"
	"sync"
	"syscall"
	"testing"
	"time"
)

type testLogger struct {
	mu     sync.Mutex
	events []string
}

func (l *testLogger) add(fields map[string]any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if event, ok := fields["event"].(string); ok {
		l.events = append(l.events, event)
	}
}
func (l *testLogger) Info(_ string, fields map[string]any)  { l.add(fields) }
func (l *testLogger) Warn(_ string, fields map[string]any)  { l.add(fields) }
func (l *testLogger) Error(_ string, fields map[string]any) { l.add(fields) }

func startHTTPServer(t *testing.T, handler http.Handler) (*http.Server, string, <-chan error) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: handler}
	done := make(chan error, 1)
	go func() { done <- server.Serve(listener) }()
	return server, "http://" + listener.Addr().String(), done
}

func TestWaitHTTPGracefulSingleNonTTYSignal(t *testing.T) {
	server, url, serveDone := startHTTPServer(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "ok")
	}))
	response, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()

	signals := make(chan os.Signal, 2)
	logger := &testLogger{}
	flushed := 0
	result := make(chan Outcome, 1)
	errors := make(chan error, 1)
	go func() {
		outcome, err := WaitHTTP(context.Background(), server, logger, Config{
			GracePeriod: time.Second,
			StdinIsTTY:  false,
			Signals:     signals,
			Flush: func(context.Context) error {
				flushed++
				return nil
			},
		})
		result <- outcome
		errors <- err
	}()

	signals <- syscall.SIGTERM
	outcome := <-result
	if err := <-errors; err != nil {
		t.Fatal(err)
	}
	if outcome.Forced || outcome.Trigger != SIGTERM {
		t.Fatalf("outcome = %#v", outcome)
	}
	if flushed != 1 {
		t.Fatalf("flush count = %d", flushed)
	}
	if err := <-serveDone; err != nil && err != http.ErrServerClosed {
		t.Fatal(err)
	}
}

func TestWaitHTTPSecondInteractiveSIGINTForces(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	server, url, _ := startHTTPServer(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		close(started)
		<-release
		_, _ = io.WriteString(w, "late")
	}))
	clientDone := make(chan struct{})
	go func() {
		defer close(clientDone)
		response, err := http.Get(url)
		if err == nil {
			_ = response.Body.Close()
		}
	}()
	<-started

	signals := make(chan os.Signal, 2)
	stdinReader, stdinWriter := io.Pipe()
	defer stdinReader.Close()
	defer stdinWriter.Close()
	result := make(chan Outcome, 1)
	go func() {
		outcome, _ := WaitHTTP(context.Background(), server, &testLogger{}, Config{
			GracePeriod: 5 * time.Second,
			StdinIsTTY:  true,
			Stdin:       stdinReader,
			Signals:     signals,
		})
		result <- outcome
	}()
	signals <- syscall.SIGINT
	time.Sleep(25 * time.Millisecond)
	signals <- syscall.SIGINT
	outcome := <-result
	close(release)
	<-clientDone
	if !outcome.Forced || outcome.Trigger != SIGINT {
		t.Fatalf("outcome = %#v", outcome)
	}
}

func TestWaitHTTPTTYEOFForces(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	server, url, _ := startHTTPServer(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		close(started)
		<-release
		_, _ = io.WriteString(w, "late")
	}))
	clientDone := make(chan struct{})
	go func() {
		defer close(clientDone)
		response, err := http.Get(url)
		if err == nil {
			_ = response.Body.Close()
		}
	}()
	<-started

	signals := make(chan os.Signal, 2)
	stdinReader, stdinWriter := io.Pipe()
	defer stdinReader.Close()
	result := make(chan Outcome, 1)
	errors := make(chan error, 1)
	go func() {
		outcome, err := WaitHTTP(context.Background(), server, &testLogger{}, Config{
			GracePeriod: 5 * time.Second,
			StdinIsTTY:  true,
			Stdin:       stdinReader,
			Signals:     signals,
		})
		result <- outcome
		errors <- err
	}()

	signals <- syscall.SIGINT
	time.Sleep(25 * time.Millisecond)
	if err := stdinWriter.Close(); err != nil {
		t.Fatal(err)
	}
	outcome := <-result
	if err := <-errors; err != nil {
		t.Fatal(err)
	}
	close(release)
	<-clientDone
	if !outcome.Forced || outcome.Trigger != StdinEOF {
		t.Fatalf("outcome = %#v", outcome)
	}
}

func TestWaitHTTPGraceDeadlineForces(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	server, url, _ := startHTTPServer(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		close(started)
		<-release
		_, _ = io.WriteString(w, "late")
	}))
	clientDone := make(chan struct{})
	go func() {
		defer close(clientDone)
		response, err := http.Get(url)
		if err == nil {
			_ = response.Body.Close()
		}
	}()
	<-started

	signals := make(chan os.Signal, 2)
	result := make(chan Outcome, 1)
	errors := make(chan error, 1)
	go func() {
		outcome, err := WaitHTTP(context.Background(), server, &testLogger{}, Config{
			GracePeriod: 40 * time.Millisecond,
			StdinIsTTY:  false,
			Signals:     signals,
		})
		result <- outcome
		errors <- err
	}()

	signals <- syscall.SIGTERM
	outcome := <-result
	if err := <-errors; err != nil {
		t.Fatal(err)
	}
	close(release)
	<-clientDone
	if !outcome.Forced || outcome.Trigger != Timeout {
		t.Fatalf("outcome = %#v", outcome)
	}
}
