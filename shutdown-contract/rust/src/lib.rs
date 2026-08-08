#![forbid(unsafe_code)]

use std::{
    env,
    error::Error,
    fmt,
    future::{pending, Future},
    io::{self, IsTerminal, Read},
    time::Duration,
};

use tokio::{sync::oneshot, time};
use tracing::{error, info, warn};

pub type BoxError = Box<dyn Error + Send + Sync + 'static>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Phase {
    Running,
    Draining,
    Forcing,
    Complete,
}

impl Phase {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Draining => "draining",
            Self::Forcing => "forcing",
            Self::Complete => "complete",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Trigger {
    Sigint,
    Sigterm,
    StdinEof,
    Timeout,
    GracefulComplete,
}

impl Trigger {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Sigint => "sigint",
            Self::Sigterm => "sigterm",
            Self::StdinEof => "stdin_eof",
            Self::Timeout => "timeout",
            Self::GracefulComplete => "graceful_complete",
        }
    }
}

impl fmt::Display for Trigger {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Action {
    Ignore,
    BeginGraceful,
    Force,
    Complete,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct State {
    pub phase: Phase,
    pub stdin_is_tty: bool,
    pub first_trigger: Option<Trigger>,
}

impl State {
    pub const fn new(stdin_is_tty: bool) -> Self {
        Self {
            phase: Phase::Running,
            stdin_is_tty,
            first_trigger: None,
        }
    }

    pub const fn apply(self, trigger: Trigger) -> Transition {
        match self.phase {
            Phase::Running => match trigger {
                Trigger::Sigint | Trigger::Sigterm => Transition {
                    state: Self {
                        phase: Phase::Draining,
                        first_trigger: Some(trigger),
                        ..self
                    },
                    action: Action::BeginGraceful,
                    show_force_hint: self.stdin_is_tty && matches!(trigger, Trigger::Sigint),
                },
                _ => Transition::ignored(self),
            },
            Phase::Draining => match trigger {
                Trigger::GracefulComplete => Transition {
                    state: Self {
                        phase: Phase::Complete,
                        ..self
                    },
                    action: Action::Complete,
                    show_force_hint: false,
                },
                Trigger::Sigint | Trigger::Sigterm | Trigger::Timeout => Transition {
                    state: Self {
                        phase: Phase::Forcing,
                        ..self
                    },
                    action: Action::Force,
                    show_force_hint: false,
                },
                Trigger::StdinEof
                    if self.stdin_is_tty
                        && matches!(self.first_trigger, Some(Trigger::Sigint)) =>
                {
                    Transition {
                        state: Self {
                            phase: Phase::Forcing,
                            ..self
                        },
                        action: Action::Force,
                        show_force_hint: false,
                    }
                }
                _ => Transition::ignored(self),
            },
            Phase::Forcing | Phase::Complete => Transition::ignored(self),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Transition {
    pub state: State,
    pub action: Action,
    pub show_force_hint: bool,
}

impl Transition {
    const fn ignored(state: State) -> Self {
        Self {
            state,
            action: Action::Ignore,
            show_force_hint: false,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Config {
    pub grace_period: Duration,
    pub stdin_is_tty: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            grace_period: grace_period_from_env(),
            stdin_is_tty: io::stdin().is_terminal(),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Outcome {
    pub forced: bool,
    pub trigger: Trigger,
}

/// Supervise a server future whose graceful-shutdown hook is controlled by
/// `graceful_tx`. The first signal sends the graceful notification. A second
/// signal, armed interactive EOF, or the deadline aborts the server task.
pub async fn supervise<F, E>(
    server: F,
    graceful_tx: oneshot::Sender<()>,
    config: Config,
) -> Result<Outcome, BoxError>
where
    F: Future<Output = Result<(), E>> + Send + 'static,
    E: Error + Send + Sync + 'static,
{
    if config.grace_period.is_zero() {
        return Err("grace period must be positive".into());
    }

    let mut signals = OsSignals::new()?;
    let mut server_handle = tokio::spawn(server);

    let first_trigger = tokio::select! {
        server_result = &mut server_handle => {
            flatten_server_result(server_result)?;
            return Ok(Outcome {
                forced: false,
                trigger: Trigger::GracefulComplete,
            });
        }
        trigger = signals.recv() => trigger?,
    };

    let first = State::new(config.stdin_is_tty).apply(first_trigger);
    debug_assert_eq!(first.action, Action::BeginGraceful);
    let mut state = first.state;

    info!(
        event = "shutdown_requested",
        phase = state.phase.as_str(),
        trigger = first_trigger.as_str(),
        stdin_is_tty = state.stdin_is_tty,
        grace_ms = config.grace_period.as_millis() as u64,
        forced = false,
        "graceful shutdown requested; listener is closing and active work is draining"
    );

    if graceful_tx.send(()).is_err() {
        warn!(
            event = "shutdown_failed",
            phase = state.phase.as_str(),
            trigger = first_trigger.as_str(),
            stdin_is_tty = state.stdin_is_tty,
            grace_ms = config.grace_period.as_millis() as u64,
            forced = false,
            "server completed before the graceful-shutdown notification was delivered"
        );
    }

    let mut eof_receiver = if first.show_force_hint {
        info!(
            event = "shutdown_force_available",
            phase = state.phase.as_str(),
            trigger = first_trigger.as_str(),
            stdin_is_tty = true,
            grace_ms = config.grace_period.as_millis() as u64,
            forced = false,
            "press Ctrl-C again or Ctrl-D to force shutdown"
        );
        spawn_stdin_eof_watcher()
    } else {
        None
    };

    let deadline = time::sleep(config.grace_period);
    tokio::pin!(deadline);

    let force_trigger = tokio::select! {
        server_result = &mut server_handle => {
            flatten_server_result(server_result)?;
            state = state.apply(Trigger::GracefulComplete).state;
            info!(
                event = "shutdown_complete",
                phase = state.phase.as_str(),
                trigger = first_trigger.as_str(),
                stdin_is_tty = state.stdin_is_tty,
                grace_ms = config.grace_period.as_millis() as u64,
                forced = false,
                "graceful shutdown complete"
            );
            return Ok(Outcome {
                forced: false,
                trigger: first_trigger,
            });
        }
        trigger = signals.recv() => trigger?,
        _ = &mut deadline => Trigger::Timeout,
        () = receive_eof(&mut eof_receiver) => Trigger::StdinEof,
    };

    let forced = state.apply(force_trigger);
    if forced.action != Action::Force {
        return Err(format!(
            "invalid force transition from {:?} via {force_trigger}",
            state.phase
        )
        .into());
    }
    state = forced.state;

    warn!(
        event = "shutdown_forced",
        phase = state.phase.as_str(),
        trigger = force_trigger.as_str(),
        stdin_is_tty = state.stdin_is_tty,
        grace_ms = config.grace_period.as_millis() as u64,
        forced = true,
        "forceful shutdown requested; active connections will be dropped"
    );

    server_handle.abort();
    match server_handle.await {
        Err(join_error) if join_error.is_cancelled() => {}
        Err(join_error) => return Err(Box::new(join_error)),
        Ok(Err(server_error)) => return Err(Box::new(server_error)),
        Ok(Ok(())) => {}
    }

    info!(
        event = "shutdown_complete",
        phase = Phase::Complete.as_str(),
        trigger = force_trigger.as_str(),
        stdin_is_tty = state.stdin_is_tty,
        grace_ms = config.grace_period.as_millis() as u64,
        forced = true,
        "forceful shutdown complete"
    );

    Ok(Outcome {
        forced: true,
        trigger: force_trigger,
    })
}

fn grace_period_from_env() -> Duration {
    env::var("SHUTDOWN_GRACE_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .map(Duration::from_millis)
        .unwrap_or(Duration::from_secs(30))
}

fn spawn_stdin_eof_watcher() -> Option<tokio::sync::mpsc::UnboundedReceiver<()>> {
    let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
    let thread = std::thread::Builder::new()
        .name("shutdown-stdin-eof".to_owned())
        .spawn(move || {
            let stdin = io::stdin();
            let mut stdin = stdin.lock();
            let mut byte = [0_u8; 1];
            loop {
                match stdin.read(&mut byte) {
                    Ok(0) => {
                        let _ = sender.send(());
                        return;
                    }
                    Ok(_) => {}
                    Err(read_error) => {
                        error!(
                            event = "shutdown_stdin_watch_failed",
                            error = %read_error,
                            "failed while waiting for terminal EOF"
                        );
                        return;
                    }
                }
            }
        });

    match thread {
        Ok(_) => Some(receiver),
        Err(spawn_error) => {
            warn!(
                event = "shutdown_stdin_watch_failed",
                error = %spawn_error,
                "could not start terminal EOF watcher; second Ctrl-C still forces shutdown"
            );
            None
        }
    }
}

async fn receive_eof(
    receiver: &mut Option<tokio::sync::mpsc::UnboundedReceiver<()>>,
) {
    match receiver {
        Some(receiver) => match receiver.recv().await {
            Some(()) => (),
            None => pending::<()>().await,
        },
        None => pending::<()>().await,
    }
}

fn flatten_server_result<E>(
    result: Result<Result<(), E>, tokio::task::JoinError>,
) -> Result<(), BoxError>
where
    E: Error + Send + Sync + 'static,
{
    match result {
        Ok(Ok(())) => Ok(()),
        Ok(Err(server_error)) => Err(Box::new(server_error)),
        Err(join_error) => Err(Box::new(join_error)),
    }
}

#[cfg(unix)]
struct OsSignals {
    sigint: tokio::signal::unix::Signal,
    sigterm: tokio::signal::unix::Signal,
}

#[cfg(unix)]
impl OsSignals {
    fn new() -> io::Result<Self> {
        use tokio::signal::unix::{signal, SignalKind};
        Ok(Self {
            sigint: signal(SignalKind::interrupt())?,
            sigterm: signal(SignalKind::terminate())?,
        })
    }

    async fn recv(&mut self) -> io::Result<Trigger> {
        tokio::select! {
            signal = self.sigint.recv() => signal
                .map(|_| Trigger::Sigint)
                .ok_or_else(|| io::Error::new(io::ErrorKind::BrokenPipe, "SIGINT stream closed")),
            signal = self.sigterm.recv() => signal
                .map(|_| Trigger::Sigterm)
                .ok_or_else(|| io::Error::new(io::ErrorKind::BrokenPipe, "SIGTERM stream closed")),
        }
    }
}

#[cfg(not(unix))]
struct OsSignals;

#[cfg(not(unix))]
impl OsSignals {
    fn new() -> io::Result<Self> {
        Ok(Self)
    }

    async fn recv(&mut self) -> io::Result<Trigger> {
        tokio::signal::ctrl_c().await?;
        Ok(Trigger::Sigint)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tty_sigint_then_sigint_forces() {
        let first = State::new(true).apply(Trigger::Sigint);
        assert_eq!(first.action, Action::BeginGraceful);
        assert!(first.show_force_hint);
        let second = first.state.apply(Trigger::Sigint);
        assert_eq!(second.action, Action::Force);
        assert_eq!(second.state.phase, Phase::Forcing);
    }

    #[test]
    fn tty_eof_only_forces_after_sigint() {
        assert_eq!(
            State::new(true).apply(Trigger::StdinEof).action,
            Action::Ignore
        );
        let first = State::new(true).apply(Trigger::Sigint);
        assert_eq!(first.state.apply(Trigger::StdinEof).action, Action::Force);
    }

    #[test]
    fn non_tty_one_sigint_begins_graceful_without_hint() {
        let first = State::new(false).apply(Trigger::Sigint);
        assert_eq!(first.action, Action::BeginGraceful);
        assert!(!first.show_force_hint);
    }

    #[test]
    fn sigterm_always_begins_graceful() {
        for stdin_is_tty in [false, true] {
            let first = State::new(stdin_is_tty).apply(Trigger::Sigterm);
            assert_eq!(first.action, Action::BeginGraceful);
            assert!(!first.show_force_hint);
        }
    }
}
