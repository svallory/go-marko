package runtime

// Or is the Go target for Marko's `??` (nullish-coalescing) operator:
// `a ?? b` translates to `runtime.Or(a, b)`.
//
// IMPORTANT: this is NOT exact JS `??` semantics. JS `??` falls back to b
// only when a is `null` or `undefined`, distinguishing those from other
// falsy values like `0`, `""`, or `false`. Go has no notion of "unset" for
// a non-pointer T -- a zero-value int and an explicitly-assigned 0 are
// indistinguishable. Or therefore falls back whenever a equals the zero
// value of T, which is a strictly broader condition than JS nullish
// checks. Callers translating `??` where the left side could legitimately
// hold a meaningful zero value (0, "", false) will get different behavior
// than Marko/JS.
func Or[T comparable](a, b T) T {
	var zero T
	if a == zero {
		return b
	}
	return a
}
