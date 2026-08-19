package runtime

import (
	"fmt"
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
// (structs, slices, maps) is treated as truthy, matching JS object
// semantics.
func isFalsy(val any) bool {
	switch v := val.(type) {
	case nil:
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
