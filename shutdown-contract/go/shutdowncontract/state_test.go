package shutdowncontract

import "testing"

func TestTTYSecondSIGINTForcesAndCountsTwoSignals(t *testing.T) {
	first := Apply(Initial(true), SIGINT)
	if first.Action != BeginGraceful || !first.ShowForceHint || first.State.SignalCount != 1 {
		t.Fatalf("first SIGINT = %#v", first)
	}
	second := Apply(first.State, SIGINT)
	if second.Action != Force || second.State.Phase != Forcing || second.State.SignalCount != 2 {
		t.Fatalf("second SIGINT = %#v", second)
	}
}

func TestTTYEOFAfterSIGINTForcesWithoutCountingSignal(t *testing.T) {
	before := Apply(Initial(true), StdinEOF)
	if before.Action != Ignore {
		t.Fatalf("EOF before signal should be ignored: %#v", before)
	}
	first := Apply(Initial(true), SIGINT)
	eof := Apply(first.State, StdinEOF)
	if eof.Action != Force || eof.State.SignalCount != 1 {
		t.Fatalf("EOF after interactive SIGINT = %#v", eof)
	}
}

func TestNonTTYAndTTYSIGTERMNerverArmEOF(t *testing.T) {
	for _, tc := range []struct {
		tty     bool
		trigger Trigger
	}{{false, SIGINT}, {false, SIGTERM}, {true, SIGTERM}} {
		first := Apply(Initial(tc.tty), tc.trigger)
		if first.Action != BeginGraceful || first.ShowForceHint {
			t.Fatalf("first trigger tty=%v trigger=%s = %#v", tc.tty, tc.trigger, first)
		}
		if eof := Apply(first.State, StdinEOF); eof.Action != Ignore {
			t.Fatalf("EOF should be ignored: %#v", eof)
		}
	}
}

func TestTimeoutAndDrainFailureForceWithoutIncrementingSignalCount(t *testing.T) {
	for _, trigger := range []Trigger{Timeout, DrainFailed} {
		first := Apply(Initial(false), SIGTERM)
		forced := Apply(first.State, trigger)
		if forced.Action != Force || forced.State.SignalCount != 1 {
			t.Fatalf("trigger %s = %#v", trigger, forced)
		}
	}
}
