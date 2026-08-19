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

// And is the Go target for JS `a && b` in VALUE position -- e.g. inside a
// class array: `class=["base", i === 0 && "active"]`.
//
// Unlike Go's `&&`, JS's `&&` is not a boolean operator: it returns one of
// its OPERANDS. `a && b` evaluates to a when a is falsy, and to b otherwise.
// That's why the class array above works at all: the entry is either `false`
// (which AttrClass skips) or the class string. And reproduces that exactly,
// using the same JS truthiness rules as Truthy, and returns `any` because
// the two operands need not share a type.
//
// The transpiler only emits And where an operand is not boolean-shaped;
// tests like `<if=a && b>` still compile to a plain Go `&&`.
//
// NOTE: Go evaluates both arguments before the call, so And -- unlike JS
// `&&` -- does not short-circuit. Marko expressions in this position are
// pure value expressions, so the only observable difference would be a
// panic from evaluating b (e.g. an out-of-range index) that JS would have
// skipped. Guard those with an `<if>` in the template instead.
func And(a, b any) any {
	if !Truthy(a) {
		return a
	}
	return b
}

// OrValue is the Go target for JS `a || b` in VALUE position, the mirror of
// And: it returns a when a is truthy, and b otherwise.
//
// This is JS-faithful in a way runtime.Or deliberately is not. Or models
// `??` over a typed zero value and returns T; OrValue models `||` over JS
// truthiness and returns the operand itself as `any`. Use of one for the
// other changes behavior for `0`/`""`/`false`.
func OrValue(a, b any) any {
	if Truthy(a) {
		return a
	}
	return b
}
