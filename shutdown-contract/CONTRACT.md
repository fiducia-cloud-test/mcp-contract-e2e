# Server shutdown contract

## Events and phases

Every network server has four phases: `running`, `draining`, `forcing`, and
`complete`.

1. The first `SIGINT` or `SIGTERM` moves the server from `running` to
   `draining`. The listener stops accepting new work and in-flight work gets a
   bounded grace period.
2. When stdin is a TTY and the first event was `SIGINT`, the process logs that a
   second `SIGINT` **or** terminal EOF (`Ctrl-D` on an empty line) forces an
   immediate close. Nothing reads stdin before that first interactive SIGINT.
3. When stdin is not a TTY, one signal is sufficient. The server drains and
   exits; a grace-period deadline remains the automatic force fallback.
4. Any second termination signal while draining, terminal EOF armed by rule 2,
   or the grace-period deadline moves the process to `forcing` and drops active
   connections.
5. `SIGTERM` always initiates graceful shutdown with one signal. A later signal
   may force, but is never required for normal service-manager shutdown.
6. Completion and every transition are structured-log events. Cleanup and
   telemetry flushing run once.

## Required log fields

- `event`: `shutdown_requested`, `shutdown_force_available`,
  `shutdown_forced`, `shutdown_complete`, or `shutdown_failed`
- `phase`: `draining`, `forcing`, or `complete`
- `trigger`: `sigint`, `sigterm`, `stdin_eof`, or `timeout`
- `stdin_is_tty`
- `grace_ms`
- `forced`

## Protocol exception

For stdio protocol servers, stdin is the transport. They must not install a
second reader. Transport EOF itself starts graceful shutdown; only signals and
an elapsed deadline force it.
