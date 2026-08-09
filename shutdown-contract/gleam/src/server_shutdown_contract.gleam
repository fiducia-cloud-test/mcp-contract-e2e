pub type Phase {
  Running
  Draining
  Forcing
  Complete
}

pub type Trigger {
  Sigint
  Sigterm
  StdinEof
  Timeout
  DrainFailed
  GracefulComplete
}

pub type FirstTrigger {
  NoTrigger
  FirstSigint
  FirstSigterm
}

pub type Action {
  Ignore
  BeginGraceful
  ForceNow
  Finish
}

pub type State {
  State(
    phase: Phase,
    stdin_is_tty: Bool,
    first_trigger: FirstTrigger,
    signal_count: Int,
  )
}

pub type Transition {
  Transition(state: State, action: Action, show_force_hint: Bool)
}

pub fn initial(stdin_is_tty: Bool) -> State {
  State(
    phase: Running,
    stdin_is_tty: stdin_is_tty,
    first_trigger: NoTrigger,
    signal_count: 0,
  )
}

pub fn apply(state: State, trigger: Trigger) -> Transition {
  case state.phase, trigger {
    Running, Sigint ->
      Transition(
        state: State(
          phase: Draining,
          stdin_is_tty: state.stdin_is_tty,
          first_trigger: FirstSigint,
          signal_count: state.signal_count + 1,
        ),
        action: BeginGraceful,
        show_force_hint: state.stdin_is_tty,
      )
    Running, Sigterm ->
      Transition(
        state: State(
          phase: Draining,
          stdin_is_tty: state.stdin_is_tty,
          first_trigger: FirstSigterm,
          signal_count: state.signal_count + 1,
        ),
        action: BeginGraceful,
        show_force_hint: False,
      )
    Draining, GracefulComplete ->
      Transition(
        state: State(
          phase: Complete,
          stdin_is_tty: state.stdin_is_tty,
          first_trigger: state.first_trigger,
          signal_count: state.signal_count,
        ),
        action: Finish,
        show_force_hint: False,
      )
    Draining, Sigint -> force(state, True)
    Draining, Sigterm -> force(state, True)
    Draining, Timeout -> force(state, False)
    Draining, DrainFailed -> force(state, False)
    Draining, StdinEof ->
      case state.stdin_is_tty, state.first_trigger {
        True, FirstSigint -> force(state, False)
        _, _ -> ignored(state)
      }
    _, _ -> ignored(state)
  }
}

fn force(state: State, increment_signal_count: Bool) -> Transition {
  Transition(
    state: State(
      phase: Forcing,
      stdin_is_tty: state.stdin_is_tty,
      first_trigger: state.first_trigger,
      signal_count: state.signal_count
        + case increment_signal_count {
          True -> 1
          False -> 0
        },
    ),
    action: ForceNow,
    show_force_hint: False,
  )
}

fn ignored(state: State) -> Transition {
  Transition(state: state, action: Ignore, show_force_hint: False)
}
