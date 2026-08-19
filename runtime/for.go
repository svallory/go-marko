package runtime

import "reflect"

// ForOf iterates items in order. It's the Go target for
// `<for|item| of=items>` with no `by` key -- no diffing/keying/resume
// bookkeeping, since this runtime never re-renders in place.
//
// items is `any`, not a generic []T, because the generated code has no way
// to know the element type of a loop's source expression: the transpiler
// works purely off the compiled Marko JS (see transpile.mjs's translateExpr),
// which erases all type information, and an Input struct field backing the
// loop may itself be typed `any` (e.g. an untyped TS field, or a value built
// up dynamically). So ForOf takes whatever the expression evaluates to and
// figures out how to walk it at runtime via reflection.
//
// This means every call pays a reflect.ValueOf + Kind check, plus one
// reflect.Value.Index per element -- slower than a native `for range` over a
// concrete slice. That cost is accepted deliberately: it's the price of not
// requiring the codegen pipeline to thread element types through every
// composition boundary (Input structs, custom tag calls, module consts) just
// to keep loops on the fast path. If profiling ever shows this matters, the
// transpiler could special-case loops whose source is a statically known
// typed slice and emit a native loop instead -- ForOf's `any` signature
// doesn't preclude that later optimization.
//
// items may be a slice, an array, or nil. A nil or non-slice/array items
// value is a no-op: this matches JS semantics, where iterating `undefined`
// or a non-array value renders nothing rather than panicking.
func ForOf(items any, fn func(item any)) {
	v := reflectSliceOrArray(items)
	if !v.IsValid() {
		return
	}
	n := v.Len()
	for i := 0; i < n; i++ {
		fn(v.Index(i).Interface())
	}
}

// ForOfIndexed is the Go target for `<for|item, i| of=items>`. See ForOf's
// doc comment for why items is `any` and the reflection cost this implies.
func ForOfIndexed(items any, fn func(item any, i int)) {
	v := reflectSliceOrArray(items)
	if !v.IsValid() {
		return
	}
	n := v.Len()
	for i := 0; i < n; i++ {
		fn(v.Index(i).Interface(), i)
	}
}

// reflectSliceOrArray returns the reflect.Value for items if it's a
// (non-nil) slice or an array, or the zero Value (IsValid() == false)
// otherwise -- covering nil, a nil slice, and any non-iterable type.
func reflectSliceOrArray(items any) reflect.Value {
	if items == nil {
		return reflect.Value{}
	}
	v := reflect.ValueOf(items)
	switch v.Kind() {
	case reflect.Slice:
		if v.IsNil() {
			return reflect.Value{}
		}
		return v
	case reflect.Array:
		return v
	default:
		return reflect.Value{}
	}
}
