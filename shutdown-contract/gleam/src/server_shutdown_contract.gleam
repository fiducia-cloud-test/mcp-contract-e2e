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
  State(phase: Phase, stdin_is_tty: Bool, first_trigger: FirstTrigger)
}

pub type Transition {
  Transition(state: State, action: Action, show_force_hint: Bool)
}

pub fn initial(stdin_is_tty: Bool) -> State {
  State(phase: Running, stdin_is_tty: stdin_is_tty, first_trigger: NoTrigger)
}

pub fn apply(state: State, trigger: Trigger) -> Transition {
  case state.phase, trigger {
    Running, Sigint ->
      Transition(
        state: State(
          phase: Draining,
          stdin_is_tty: state.stdin_is_tty,
          first_trigger: FirstSigint,
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
        ),
        action: Finish,
        show_force_hint: False,
      )
    Draining, Sigint -> force(state)
    Draining, Sigterm -> force(state)
    Draining, Timeout -> force(state)
    Draining, StdinEof ->
      case state.stdin_is_tty, state.first_trigger {
        True, FirstSigint -> force(state)
        _, _ -> ignored(state)
      }
    _, _ -> ignored(state)
  }
}

fn force(state: State) -> Transition {
  Transition(
    state: State(
      phase: Forcing,
      stdin_is_tty: state.stdin_is_tty,
      first_trigger: state.first_trigger,
    ),
    action: ForceNow,
    show_force_hint: False,
  )
}

fn ignored(state: State) -> Transition {
  Transition(state: state, action: Ignore, show_force_hint: False)
}
