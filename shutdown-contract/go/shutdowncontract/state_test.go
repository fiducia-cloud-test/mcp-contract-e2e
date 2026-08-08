package shutdowncontract

import "testing"

func TestTTYSecondSIGINTForces(t *testing.T) {
	first := Apply(Initial(true), SIGINT)
	if first.Action != BeginGraceful || !first.ShowForceHint {
		t.Fatalf("first SIGINT = %#v", first)
	}
	second := Apply(first.State, SIGINT)
	if second.Action != Force || second.State.Phase != Forcing {
		t.Fatalf("second SIGINT = %#v", second)
	}
}

func TestTTYEOFAfterSIGINTForces(t *testing.T) {
	before := Apply(Initial(true), StdinEOF)
	if before.Action != Ignore {
		t.Fatalf("EOF before signal should be ignored: %#v", before)
	}
	first := Apply(Initial(true), SIGINT)
	eof := Apply(first.State, StdinEOF)
	if eof.Action != Force {
		t.Fatalf("EOF after interactive SIGINT = %#v", eof)
	}
}

func TestNonTTYOneSignalBeginsGraceful(t *testing.T) {
	first := Apply(Initial(false), SIGINT)
	if first.Action != BeginGraceful || first.ShowForceHint {
		t.Fatalf("non-TTY SIGINT = %#v", first)
	}
}

func TestSIGTERMAlwaysBeginsGraceful(t *testing.T) {
	for _, tty := range []bool{false, true} {
		first := Apply(Initial(tty), SIGTERM)
		if first.Action != BeginGraceful || first.ShowForceHint {
			t.Fatalf("SIGTERM tty=%v = %#v", tty, first)
		}
	}
}
