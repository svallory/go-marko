package runtime

import "testing"

func TestOr(t *testing.T) {
	t.Run("string", func(t *testing.T) {
		if got := Or("", "fallback"); got != "fallback" {
			t.Errorf("Or(%q, %q) = %q, want %q", "", "fallback", got, "fallback")
		}
		if got := Or("value", "fallback"); got != "value" {
			t.Errorf("Or(%q, %q) = %q, want %q", "value", "fallback", got, "value")
		}
	})

	t.Run("int zero falls back (NOT exact JS ?? semantics)", func(t *testing.T) {
		// In JS, `0 ?? 5` === 0 (0 is not nullish). Or can't distinguish
		// "explicitly zero" from "unset", so it falls back here -- this is
		// the documented deviation from `??`.
		if got := Or(0, 5); got != 5 {
			t.Errorf("Or(0, 5) = %d, want 5 (documented zero-value fallback)", got)
		}
	})

	t.Run("nonzero int wins", func(t *testing.T) {
		if got := Or(3, 5); got != 3 {
			t.Errorf("Or(3, 5) = %d, want 3", got)
		}
	})

	t.Run("bool false falls back", func(t *testing.T) {
		if got := Or(false, true); got != true {
			t.Errorf("Or(false, true) = %v, want true", got)
		}
	})

	t.Run("bool true wins", func(t *testing.T) {
		if got := Or(true, false); got != true {
			t.Errorf("Or(true, false) = %v, want true", got)
		}
	})

	t.Run("pointer nil falls back", func(t *testing.T) {
		var a *int
		b := new(int)
		*b = 42
		got := Or(a, b)
		if got != b {
			t.Errorf("Or(nil, b) = %v, want %v", got, b)
		}
	})

	t.Run("pointer non-nil wins", func(t *testing.T) {
		a := new(int)
		*a = 1
		var b *int
		got := Or(a, b)
		if got != a {
			t.Errorf("Or(a, nil) = %v, want %v", got, a)
		}
	})

	t.Run("struct zero value falls back", func(t *testing.T) {
		type pt struct{ X, Y int }
		got := Or(pt{}, pt{X: 1, Y: 2})
		if got != (pt{X: 1, Y: 2}) {
			t.Errorf("Or(zero struct, fallback) = %+v, want {1 2}", got)
		}
	})
}
