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

// And/OrValue are the VALUE-position translations of JS `&&`/`||`: unlike
// Go's boolean operators they return one of their OPERANDS, which is what
// makes `class=["base", i === 0 && "active"]` work.
func TestAnd(t *testing.T) {
	cases := []struct {
		name string
		a, b any
		want any
	}{
		// Falsy a short-circuits to a ITSELF, not to false.
		{"false && string -> false", false, "active", false},
		{"empty string && string -> empty string", "", "active", ""},
		{"zero && string -> 0", 0, "active", 0},
		{"nil && string -> nil", nil, "active", nil},
		// Truthy a yields b, whatever b is -- including a falsy b.
		{"true && string -> string", true, "active", "active"},
		{"comparison && string -> string", 0 == 0, "bg-accent/50", "bg-accent/50"},
		{"nonzero && string -> string", 3, "active", "active"},
		{"true && false -> false", true, false, false},
		{"true && empty -> empty", true, "", ""},
		{"string && string -> second", "a", "b", "b"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := And(c.a, c.b); got != c.want {
				t.Errorf("And(%#v, %#v) = %#v, want %#v", c.a, c.b, got, c.want)
			}
		})
	}
}

func TestOrValue(t *testing.T) {
	cases := []struct {
		name string
		a, b any
		want any
	}{
		// Truthy a wins and is returned as-is.
		{"string || fallback -> string", "given", "fallback", "given"},
		{"true || fallback -> true", true, "fallback", true},
		{"nonzero || fallback -> number", 7, "fallback", 7},
		// Falsy a yields b, whatever b is.
		{"empty || fallback -> fallback", "", "fallback", "fallback"},
		{"zero || fallback -> fallback", 0, "fallback", "fallback"},
		{"false || fallback -> fallback", false, "fallback", "fallback"},
		{"nil || fallback -> fallback", nil, "fallback", "fallback"},
		{"nil || nil -> nil", nil, nil, nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := OrValue(c.a, c.b); got != c.want {
				t.Errorf("OrValue(%#v, %#v) = %#v, want %#v", c.a, c.b, got, c.want)
			}
		})
	}
}

// OrValue is JS-faithful where Or deliberately is not: Or falls back on the
// typed ZERO value, OrValue on JS falsiness. They agree on ""/0 but differ in
// what they return and accept -- documenting that here so a future refactor
// can't quietly collapse the two.
func TestOrValueIsNotOr(t *testing.T) {
	// Or is generic over comparable and returns T; OrValue returns any.
	if got := Or("", "fallback"); got != "fallback" {
		t.Errorf(`Or("", "fallback") = %q, want "fallback"`, got)
	}
	if got := OrValue("", "fallback"); got != "fallback" {
		t.Errorf(`OrValue("", "fallback") = %v, want "fallback"`, got)
	}
	// A false bool: Or sees the zero value, OrValue sees falsiness -- same
	// answer here, but OrValue also accepts operands of differing types,
	// which Or (a single T) cannot express at all.
	if got := OrValue(false, 42); got != 42 {
		t.Errorf("OrValue(false, 42) = %v, want 42", got)
	}
}
