package runtime

import (
	"sort"
	"strconv"
)

// ScopeState is an insertion-ordered string-keyed map: the Go stand-in for a
// JS object in resume state.
//
// Ordering matters because the serializer emits properties in JS property
// order, and a Go `map` iterates randomly. JS orders own string keys as
// "integer-like keys first, ascending numerically, then the remaining keys in
// insertion order" -- ScopeState records insertion order, and Keys() applies
// the integer-first rule on top.
//
// The zero value is ready to use; Set on a nil *ScopeState panics, so build
// one with NewScopeState or a composite literal.
//
// Resume support; generated code only; not stable.
type ScopeState struct {
	keys []string
	vals map[string]any
}

// NewScopeState returns an empty ScopeState.
//
// Resume support; generated code only; not stable.
func NewScopeState() *ScopeState {
	return &ScopeState{vals: map[string]any{}}
}

// ScopeStateOf builds a ScopeState from alternating key/value arguments,
// preserving the order they are given in. It is the ergonomic form for
// generated code, which knows its keys at compile time:
//
//	runtime.ScopeStateOf("a", 1, "b", "two")
//
// Panics if len(kv) is odd or a key is not a string.
//
// Resume support; generated code only; not stable.
func ScopeStateOf(kv ...any) *ScopeState {
	if len(kv)%2 != 0 {
		panic("runtime: ScopeStateOf needs an even number of arguments")
	}
	s := NewScopeState()
	for i := 0; i < len(kv); i += 2 {
		k, ok := kv[i].(string)
		if !ok {
			panic("runtime: ScopeStateOf key must be a string")
		}
		s.Set(k, kv[i+1])
	}
	return s
}

// Set stores a value, appending the key to the insertion order the first time
// it is seen. Re-setting an existing key overwrites the value and keeps the
// original position, matching JS object assignment.
//
// Resume support; generated code only; not stable.
func (s *ScopeState) Set(key string, val any) {
	if s.vals == nil {
		s.vals = map[string]any{}
	}
	if _, seen := s.vals[key]; !seen {
		s.keys = append(s.keys, key)
	}
	s.vals[key] = val
}

// Get returns the value for key and whether it was present.
//
// Resume support; generated code only; not stable.
func (s *ScopeState) Get(key string) (any, bool) {
	if s == nil {
		return nil, false
	}
	v, ok := s.vals[key]
	return v, ok
}

// Len returns the number of properties.
//
// Resume support; generated code only; not stable.
func (s *ScopeState) Len() int {
	if s == nil {
		return 0
	}
	return len(s.keys)
}

// Keys returns the property names in JS enumeration order: integer-like keys
// first in ascending numeric order, then all remaining keys in insertion
// order.
//
// Resume support; generated code only; not stable.
func (s *ScopeState) Keys() []string {
	if s == nil {
		return nil
	}
	var ints []string
	var rest []string
	for _, k := range s.keys {
		if isArrayIndexKey(k) {
			ints = append(ints, k)
		} else {
			rest = append(rest, k)
		}
	}
	sort.Slice(ints, func(i, j int) bool {
		a, _ := strconv.ParseUint(ints[i], 10, 64)
		b, _ := strconv.ParseUint(ints[j], 10, 64)
		return a < b
	})
	return append(ints, rest...)
}

// merge folds other's properties into s, matching the repeated-_scope merge
// the JS writer performs (html.mjs:2173).
func (s *ScopeState) merge(other *ScopeState) {
	if other == nil {
		return
	}
	for _, k := range other.keys {
		s.Set(k, other.vals[k])
	}
}

// isArrayIndexKey reports whether key is a canonical array index, which is
// what makes JS sort it ahead of the string keys. That means a run of digits
// with no leading zero (except "0" itself) that fits in a uint32 below
// 2^32-1.
func isArrayIndexKey(key string) bool {
	if key == "" {
		return false
	}
	if key == "0" {
		return true
	}
	if key[0] == '0' {
		return false
	}
	for i := 0; i < len(key); i++ {
		if key[i] < '0' || key[i] > '9' {
			return false
		}
	}
	n, err := strconv.ParseUint(key, 10, 64)
	return err == nil && n < 4294967295
}

// ScopeRef is a reference to another scope by id. It serializes to `_(id)`,
// the decoder's getScope call, and is never hoisted into a `_.x` reference
// slot.
//
// Generated code uses it for the parent link (`_`) and for any other state
// field that holds a scope.
//
// Resume support; generated code only; not stable.
type ScopeRef struct {
	ID int
}

// Scope returns a ScopeRef for the given scope id.
//
// Resume support; generated code only; not stable.
func Scope(id int) ScopeRef {
	return ScopeRef{ID: id}
}

// Undefined is the explicit JS `undefined` marker.
//
// Go's nil maps to JS `null`, so a separate value is needed to express
// `undefined`, which the serializer treats very differently: it is DROPPED in
// object position and becomes the positional `$` hole in array position.
//
// Resume support; generated code only; not stable.
type undefinedType struct{}

// Undefined is the singleton JS `undefined` value. See undefinedType.
//
// Resume support; generated code only; not stable.
var Undefined = undefinedType{}
