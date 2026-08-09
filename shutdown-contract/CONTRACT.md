# Server shutdown contract

## Events and phases

Every network server has four phases: `running`, `draining`, `forcing`, and
`complete`.

1. The first `SIGINT` or `SIGTERM` moves the server from `running` to
   `draining`. The listener stops accepting new work and in-flight work gets one
   bounded grace budget.
2. When stdin is a TTY **and the first event was `SIGINT`**, the process logs
   that a second `SIGINT` or terminal EOF (`Ctrl-D` on an empty line) forces an
   immediate close. Nothing installs an EOF listener, resumes stdin, or reads a
   byte before that first interactive SIGINT.
3. `SIGTERM` starts graceful shutdown but never arms terminal EOF, even in a
   TTY. This preserves predictable Kubernetes, Docker, and systemd behavior.
4. When stdin is not a TTY, it is never read. One signal starts graceful drain;
   a second signal or the grace deadline remains the force fallback.
5. Any second termination signal while draining, EOF armed by rule 2, a
   graceful-drain error, or the deadline moves the process to `forcing` and
   drops active connections.
6. `signal_count` counts operating-system `SIGINT`/`SIGTERM` events only. EOF,
   timeout, drain failure, and programmatic cancellation do not increment it.
7. Completion and every transition are structured-log events. Cleanup and
   telemetry flushing run exactly once and remain deadline-bounded even when a
   callback ignores cancellation.

## Required log fields

- `event`: `shutdown_requested`, `shutdown_force_available`,
  `shutdown_forced`, `shutdown_complete`, or `shutdown_failed`
- `phase`: `draining`, `forcing`, or `complete`
- `trigger`: `sigint`, `sigterm`, `stdin_eof`, `timeout`, or `drain_failed`
- `stdin_is_tty`
- `signal_count`
- `grace_ms`
- `forced`

## Protocol exception

For stdio protocol servers, stdin is the transport. They must not install a
second reader. Transport EOF itself starts graceful shutdown; only signals and
an elapsed deadline force it.
