package runtime

import (
	"fmt"
	"reflect"
	"strconv"
)

// Truthy replicates JS truthiness (`if (val)`) for the value types a
// marko-go template can produce. Used by generated code wherever a Marko
// `<if>` test isn't already a Go bool (e.g. `input.items.length`, which
// translates to a Go int -- Go, unlike JS, won't implicitly coerce that
// in an if-condition).
func Truthy(val any) bool {
	return !isFalsy(val)
}

// isFalsy replicates JS truthiness for the value types a marko-go template
// can produce: nil, bool, string, and Go's numeric types. Anything else
// (structs, non-nil pointers, maps, slices) is treated as truthy, matching
// JS object semantics.
//
// A NIL POINTER is falsy. This matters because an optional attr tag
// (`head?: Marko.AttrTag<{...}>`) is generated as a POINTER field, and the
// compiled JS tests it with a bare `if (input.head)` -- which reaches here
// as `Truthy(input.Head)`. Go boxes a typed nil pointer into a NON-nil
// interface, so `case nil` below never sees it; only reflection can. Same
// reasoning for nil maps/slices/funcs/interfaces: those are the Go
// representation of an absent value, i.e. JS `undefined`, which is falsy.
// (JS arrays/objects are truthy even when empty, so an EMPTY-but-non-nil
// map or slice stays truthy -- only nil-ness is tested.)
func isFalsy(val any) bool {
	switch v := val.(type) {
	case nil:
		return true
	case undefinedType:
		// JS `undefined` is falsy. It reaches here from runtime.Absent, which
		// is how an omitted optional input field is distinguished from a
		// deliberate zero value on the wire.
		return true
	case bool:
		return !v
	case string:
		return v == ""
	case int:
		return v == 0
	case int8:
		return v == 0
	case int16:
		return v == 0
	case int32:
		return v == 0
	case int64:
		return v == 0
	case uint:
		return v == 0
	case uint8:
		return v == 0
	case uint16:
		return v == 0
	case uint32:
		return v == 0
	case uint64:
		return v == 0
	case float32:
		return v == 0
	case float64:
		return v == 0
	default:
		return isNilValue(val)
	}
}

// isNilValue reports whether val is a nil pointer, map, slice, func, chan or
// interface boxed inside a non-nil `any`. See isFalsy for why this needs
// reflection.
func isNilValue(val any) bool {
	rv := reflect.ValueOf(val)
	switch rv.Kind() {
	case reflect.Ptr, reflect.Map, reflect.Slice, reflect.Func, reflect.Chan, reflect.Interface, reflect.UnsafePointer:
		return rv.IsNil()
	default:
		return false
	}
}

// isZero reports whether val is the numeric literal 0. Marko's escape
// helpers special-case this: `val ? escape(val) : val === 0 ? "0" : ""`,
// because 0 is falsy in JS but should still render.
func isZero(val any) bool {
	switch v := val.(type) {
	case int:
		return v == 0
	case int8:
		return v == 0
	case int16:
		return v == 0
	case int32:
		return v == 0
	case int64:
		return v == 0
	case uint:
		return v == 0
	case uint8:
		return v == 0
	case uint16:
		return v == 0
	case uint32:
		return v == 0
	case uint64:
		return v == 0
	case float32:
		return v == 0
	case float64:
		return v == 0
	default:
		return false
	}
}

// String narrows an `any`-typed template expression to the Go `string` a
// generated Input field declares.
//
// It exists because JS `&&`/`||` return an OPERAND, not a bool: an
// expression like `class=($global.path === "/x" && "active")` is either the
// class string or `false`, so it translates to runtime.And, which returns
// `any`. When the receiving field is declared `class?: string`, that `any`
// has to become a string somewhere, and only the call site knows the target
// type.
//
// A FALSY value becomes "" -- `false`, `nil`, and `0` all mean "no class
// here", and "" is the Go zero value the field would have held had the
// attribute been omitted entirely. A truthy value is coerced with the same
// rules as text interpolation (toJSString).
func String(val any) string {
	if isFalsy(val) {
		return ""
	}
	return toJSString(val)
}

// toJSString replicates JS's `val + ""` string coercion for the value
// types a marko-go template can produce.
func toJSString(val any) string {
	switch v := val.(type) {
	case string:
		return v
	case int:
		return strconv.Itoa(v)
	case int64:
		return strconv.FormatInt(v, 10)
	case float64:
		return strconv.FormatFloat(v, 'g', -1, 64)
	case float32:
		return strconv.FormatFloat(float64(v), 'g', -1, 32)
	case bool:
		return strconv.FormatBool(v)
	case fmt.Stringer:
		return v.String()
	default:
		return fmt.Sprintf("%v", v)
	}
}

// Absent maps a Go zero value back to JS `undefined`.
//
// Go has no "unset" for a scalar struct field, so marko-go's generated Input
// structs use the zero value to mean "attribute not passed" (see the codegen's
// inputstruct notes). That works for rendering decisions, but it is NOT what
// the wire says: Marko receives `undefined` for an omitted attribute and drops
// it from both the markup and the resume payload, while a real empty string
// renders as a bare attribute (` target`) and serializes as `""`.
//
// Generated code therefore wraps every read of an OPTIONAL scalar input field
// in Absent, which returns:
//
//	Undefined  when v is the zero value ("" / 0 / false / nil)
//	v          otherwise
//
// Attr and Attrs treat Undefined as void, and the resume serializer drops it in
// object position and writes the positional `$` hole in array position -- which
// is exactly what JS does with `undefined` in each of those places.
//
// The cost is the documented flip side of the zero-value convention: a template
// that deliberately passes `target=""` is indistinguishable from one that omits
// it. That trade is already made by the Input struct shape; Absent only makes
// the two ends agree about which side of it we are on.
func Absent(v any) any {
	// isFalsy is exactly "is the Go zero value" for every scalar the Input
	// structs can hold, plus nil-ness for pointers/maps/slices -- which is the
	// same test the zero-value convention already uses everywhere else.
	if isFalsy(v) {
		return Undefined
	}
	return v
}
