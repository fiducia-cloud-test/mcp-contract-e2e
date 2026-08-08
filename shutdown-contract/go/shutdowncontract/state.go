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
// transition table.
type State struct {
	Phase        Phase
	StdinIsTTY   bool
	FirstTrigger Trigger
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

// Apply enforces the fleet shutdown contract without doing I/O.
func Apply(state State, trigger Trigger) Result {
	switch state.Phase {
	case Running:
		if trigger != SIGINT && trigger != SIGTERM {
			return Result{State: state, Action: Ignore}
		}
		state.Phase = Draining
		state.FirstTrigger = trigger
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
		signalForces := trigger == SIGINT || trigger == SIGTERM
		if trigger == Timeout || eofForces || signalForces {
			state.Phase = Forcing
			return Result{State: state, Action: Force}
		}
	}
	return Result{State: state, Action: Ignore}
}
