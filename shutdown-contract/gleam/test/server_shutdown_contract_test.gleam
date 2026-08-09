import gleeunit
import gleeunit/should
import server_shutdown_contract.{
  BeginGraceful, DrainFailed, ForceNow, Forcing, Ignore, Sigint, Sigterm,
  StdinEof, Timeout, Transition,
}

pub fn main() {
  gleeunit.main()
}

pub fn tty_second_sigint_forces_and_counts_two_signals_test() {
  let first =
    server_shutdown_contract.apply(
      server_shutdown_contract.initial(True),
      Sigint,
    )
  first.action |> should.equal(BeginGraceful)
  first.show_force_hint |> should.equal(True)
  first.state.signal_count |> should.equal(1)

  let second = server_shutdown_contract.apply(first.state, Sigint)
  second.action |> should.equal(ForceNow)
  second.state.phase |> should.equal(Forcing)
  second.state.signal_count |> should.equal(2)
}

pub fn tty_eof_only_forces_after_sigint_without_counting_signal_test() {
  let before =
    server_shutdown_contract.apply(
      server_shutdown_contract.initial(True),
      StdinEof,
    )
  before.action |> should.equal(Ignore)

  let first =
    server_shutdown_contract.apply(
      server_shutdown_contract.initial(True),
      Sigint,
    )
  let eof = server_shutdown_contract.apply(first.state, StdinEof)
  eof.action |> should.equal(ForceNow)
  eof.state.signal_count |> should.equal(1)
}

pub fn non_tty_and_tty_sigterm_never_arm_eof_test() {
  let non_tty =
    server_shutdown_contract.apply(
      server_shutdown_contract.initial(False),
      Sigint,
    )
  non_tty.action |> should.equal(BeginGraceful)
  non_tty.show_force_hint |> should.equal(False)
  server_shutdown_contract.apply(non_tty.state, StdinEof).action
  |> should.equal(Ignore)

  let Transition(tty_term_state, tty_term_action, tty_term_hint) =
    server_shutdown_contract.apply(
      server_shutdown_contract.initial(True),
      Sigterm,
    )
  tty_term_action |> should.equal(BeginGraceful)
  tty_term_hint |> should.equal(False)
  tty_term_state.signal_count |> should.equal(1)
  server_shutdown_contract.apply(tty_term_state, StdinEof).action
  |> should.equal(Ignore)
}

pub fn timeout_and_drain_failure_force_without_counting_signal_test() {
  let first =
    server_shutdown_contract.apply(
      server_shutdown_contract.initial(False),
      Sigterm,
    )

  let timeout = server_shutdown_contract.apply(first.state, Timeout)
  timeout.action |> should.equal(ForceNow)
  timeout.state.signal_count |> should.equal(1)

  let failed = server_shutdown_contract.apply(first.state, DrainFailed)
  failed.action |> should.equal(ForceNow)
  failed.state.signal_count |> should.equal(1)
}
