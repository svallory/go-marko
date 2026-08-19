package runtime

import "reflect"

// ForOf iterates items in order. It's the Go target for
// `<for|item| of=items>` with no `by` key -- no diffing/keying/resume
// bookkeeping, since this runtime never re-renders in place.
//
// This is the *typed* variant, used whenever the transpiler can statically
// infer the element type of the loop's source expression -- which it can for
// any expression rooted in an Input field, since the Input struct's Go types
// come from the template's own `export interface Input` block (see
// inputstruct.mjs) and are threaded through nested structs and loop
// variables by transpile.mjs's type inference. A typed loop costs nothing at
// runtime: it's a plain `for range` over a concrete slice, and the callback
// receives a concrete T (so `event.Label` type-checks in generated Go).
//
// When the element type is NOT statically known -- an Input field declared
// `any`, a `[]any` literal, an expression the inferencer doesn't model --
// the transpiler emits ForOfAny instead, which walks the value reflectively.
//
// A nil slice is a no-op, matching JS semantics where iterating `undefined`
// renders nothing rather than panicking.
func ForOf[T any](items []T, fn func(item T)) {
	for _, item := range items {
		fn(item)
	}
}

// ForOfIndexed is the Go target for `<for|item, i| of=items>` when the
// element type is statically known. See ForOf.
func ForOfIndexed[T any](items []T, fn func(item T, i int)) {
	for i, item := range items {
		fn(item, i)
	}
}

// ForOfAny is the reflection fallback for ForOf: the target for
// `<for|item| of=items>` when the transpiler cannot infer a concrete element
// type for `items` (e.g. it's an `any`-typed Input field, or a value built up
// dynamically). Every call pays a reflect.ValueOf + Kind check plus one
// reflect.Value.Index per element; that cost only applies to loops that
// genuinely have no static type, and is the price of accepting `any` rather
// than refusing to compile the template.
//
// items may be a slice, an array, or nil. A nil or non-slice/array items
// value is a no-op: this matches JS semantics, where iterating `undefined`
// or a non-array value renders nothing rather than panicking.
func ForOfAny(items any, fn func(item any)) {
	v := reflectSliceOrArray(items)
	if !v.IsValid() {
		return
	}
	n := v.Len()
	for i := 0; i < n; i++ {
		fn(v.Index(i).Interface())
	}
}

// ForOfIndexedAny is the reflection fallback for ForOfIndexed. See ForOfAny.
func ForOfIndexedAny(items any, fn func(item any, i int)) {
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
