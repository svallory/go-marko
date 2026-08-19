package runtime_test

import (
	"testing"

	"github.com/svallory/go-marko/runtime"
)

type section struct{ Content runtime.Body }

// TestTruthy pins JS truthiness for every value shape generated code can
// hand to `runtime.Truthy`.
//
// The nil-pointer rows are the load-bearing ones (FR11): an optional attr
// tag is a POINTER field, and a template's `<if=input.head>` reaches the
// runtime as `Truthy(input.Head)`. Go boxes a typed nil pointer into a
// NON-nil interface, so a naive `val == nil` check reports true for a
// section that was never passed -- and the layout would then dereference it
// and panic. Only reflection sees through the box.
func TestTruthy(t *testing.T) {
	var nilSection *section
	var nilMap map[string]any
	var nilSlice []string
	var nilBody runtime.Body
	var nilAny any

	tests := []struct {
		name string
		val  any
		want bool
	}{
		// The absent-value cases -- JS `undefined`.
		{"untyped nil", nil, false},
		{"nil any", nilAny, false},
		{"typed nil pointer", nilSection, false},
		{"nil map", nilMap, false},
		{"nil slice", nilSlice, false},
		{"nil func (runtime.Body)", nilBody, false},

		// Present, so truthy -- even when empty, matching JS objects.
		{"non-nil pointer", &section{}, true},
		{"empty non-nil map", map[string]any{}, true},
		{"empty non-nil slice", []string{}, true},
		{"non-nil func", runtime.Body(func(*runtime.Writer) {}), true},
		{"struct value", section{}, true},

		// Ordinary JS falsiness.
		{"false", false, false},
		{"true", true, true},
		{"empty string", "", false},
		{"non-empty string", "x", true},
		{"zero int", 0, false},
		{"non-zero int", 1, true},
		{"zero float64", 0.0, false},
		{"non-zero float64", 1.5, true},
		// "0" is a non-empty string: truthy in JS, unlike the number 0.
		{"string zero", "0", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := runtime.Truthy(tt.val); got != tt.want {
				t.Fatalf("Truthy(%#v) = %v, want %v", tt.val, got, tt.want)
			}
		})
	}
}

// TestTruthyNilPointerGuardsDeref is the failure this fix prevents, written
// the way generated code actually uses Truthy.
func TestTruthyNilPointerGuardsDeref(t *testing.T) {
	var head *section // <page-layout> rendered without a <@head> section

	if runtime.Truthy(head) {
		t.Fatal("Truthy(nil *section) = true; generated code would deref and panic")
	}
}

// TestString covers the coercion generated code applies when an `any`-typed
// expression (runtime.And / OrValue, which return an OPERAND like JS does)
// lands in a string-typed Input field.
func TestString(t *testing.T) {
	tests := []struct {
		name string
		val  any
		want string
	}{
		// `cond && "active"` with cond false yields `false`, meaning "no
		// class" -- the same as the field having been omitted.
		{"false", false, ""},
		{"nil", nil, ""},
		{"empty string", "", ""},
		{"zero int", 0, ""},
		{"string", "active", "active"},
		{"true", true, "true"},
		{"int", 42, "42"},
		// Integral float64s print without a decimal point, as JS does.
		{"integral float", 3.0, "3"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := runtime.String(tt.val); got != tt.want {
				t.Fatalf("String(%#v) = %q, want %q", tt.val, got, tt.want)
			}
		})
	}
}
