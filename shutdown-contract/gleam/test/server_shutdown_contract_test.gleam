import gleeunit
import gleeunit/should
import server_shutdown_contract.{
  BeginGraceful, ForceNow, Forcing, Ignore, Sigint, Sigterm, StdinEof,
  Transition,
}

pub fn main() {
  gleeunit.main()
}

pub fn tty_second_sigint_forces_test() {
  let first =
    server_shutdown_contract.apply(
      server_shutdown_contract.initial(True),
      Sigint,
    )
  first.action
  |> should.equal(BeginGraceful)
  first.show_force_hint
  |> should.equal(True)

  let second = server_shutdown_contract.apply(first.state, Sigint)
  second.action
  |> should.equal(ForceNow)
  second.state.phase
  |> should.equal(Forcing)
}

pub fn tty_eof_only_forces_after_sigint_test() {
  let before =
    server_shutdown_contract.apply(
      server_shutdown_contract.initial(True),
      StdinEof,
    )
  before.action
  |> should.equal(Ignore)

  let first =
    server_shutdown_contract.apply(
      server_shutdown_contract.initial(True),
      Sigint,
    )
  let eof = server_shutdown_contract.apply(first.state, StdinEof)
  eof.action
  |> should.equal(ForceNow)
}

pub fn non_tty_one_sigint_begins_graceful_test() {
  let first =
    server_shutdown_contract.apply(
      server_shutdown_contract.initial(False),
      Sigint,
    )
  first.action
  |> should.equal(BeginGraceful)
  first.show_force_hint
  |> should.equal(False)
}

pub fn sigterm_always_begins_graceful_test() {
  let Transition(_, non_tty_action, non_tty_hint) =
    server_shutdown_contract.apply(
      server_shutdown_contract.initial(False),
      Sigterm,
    )
  non_tty_action
  |> should.equal(BeginGraceful)
  non_tty_hint
  |> should.equal(False)

  let Transition(_, tty_action, tty_hint) =
    server_shutdown_contract.apply(
      server_shutdown_contract.initial(True),
      Sigterm,
    )
  tty_action
  |> should.equal(BeginGraceful)
  tty_hint
  |> should.equal(False)
}
