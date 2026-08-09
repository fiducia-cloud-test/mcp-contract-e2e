package shutdowncontract

// Phase is the process-wide server shutdown phase.
type Phase string

const (
	Running  Phase = "running"
	Draining Phase = "draining"
	Forcing  Phase = "forcing"
	Complete Phase = "complete"
)

// Trigger is an input to the shutdown state machine.
type Trigger string

const (
	SIGINT           Trigger = "sigint"
	SIGTERM          Trigger = "sigterm"
	StdinEOF         Trigger = "stdin_eof"
	Timeout          Trigger = "timeout"
	DrainFailed      Trigger = "drain_failed"
	GracefulComplete Trigger = "graceful_complete"
)

// Action is the side effect requested by a state transition.
type Action string

const (
	Ignore        Action = "ignore"
	BeginGraceful Action = "begin_graceful"
	Force         Action = "force"
	Finish        Action = "complete"
)

// State is deliberately small so every server language can implement the same
// transition table. SignalCount counts SIGINT/SIGTERM only.
type State struct {
	Phase        Phase
	StdinIsTTY   bool
	FirstTrigger Trigger
	SignalCount  int
}

// Result is the deterministic output of Apply.
type Result struct {
	State         State
	Action        Action
	ShowForceHint bool
}

func Initial(stdinIsTTY bool) State {
	return State{Phase: Running, StdinIsTTY: stdinIsTTY}
}

func isSignal(trigger Trigger) bool {
	return trigger == SIGINT || trigger == SIGTERM
}

// Apply enforces the fleet shutdown contract without doing I/O.
func Apply(state State, trigger Trigger) Result {
	switch state.Phase {
	case Running:
		if !isSignal(trigger) {
			return Result{State: state, Action: Ignore}
		}
		state.Phase = Draining
		state.FirstTrigger = trigger
		state.SignalCount++
		return Result{
			State:         state,
			Action:        BeginGraceful,
			ShowForceHint: state.StdinIsTTY && trigger == SIGINT,
		}
	case Draining:
		if trigger == GracefulComplete {
			state.Phase = Complete
			return Result{State: state, Action: Finish}
		}
		eofForces := trigger == StdinEOF && state.StdinIsTTY && state.FirstTrigger == SIGINT
		if trigger == Timeout || trigger == DrainFailed || eofForces || isSignal(trigger) {
			state.Phase = Forcing
			if isSignal(trigger) {
				state.SignalCount++
			}
			return Result{State: state, Action: Force}
		}
	}
	return Result{State: state, Action: Ignore}
}
