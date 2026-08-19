package runtime

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// stringDedupLength mirrors STRING_DEDUP_LENGTH (html.mjs:1131): only strings
// LONGER than this are eligible for the `_.x` reference table. It is a magic
// constant in the runtime with no external contract -- a bump there silently
// changes payload bytes for any string in the 12-13 char range.
const stringDedupLength = 12

// refIDAlphabet is the reference-slot name alphabet (nextId, html.mjs:1716).
// The first character is taken with `n % 53`, which spans only a..z A..Z $ --
// index 53 (`_`) is unreachable, which is exactly what keeps `_._` free for
// the runtime's registry. Subsequent characters use the full 64 via `n & 63`.
const refIDAlphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ$_0123456789"

// serializer holds the state of one render's resume serialization. It
// outlives a single flush: ids, refs and strs persist so cross-flush dedup
// works, while buf and wroteUndefined reset per flush.
type serializer struct {
	ids            int
	flushID        int
	wroteUndefined bool

	// buf MUST stay a chunk list rather than a strings.Builder: assigning a
	// reference id back-patches an EARLIER chunk (see assignID), and that is
	// only possible while the pieces are still separate.
	buf []string

	strs map[string]*valueRef
	// refs is keyed by pointer identity, which is how the JS side's WeakMap
	// behaves. See refKeyOf for how identity is derived from an `any`.
	refs map[any]*valueRef

	// inProgress tracks values on the current write path, so a value
	// reachable from its own ancestor chain is detected as a cycle.
	inProgress map[any]bool

	err error
}

// valueRef tracks one deduplicated value.
type valueRef struct {
	id string
	// pos is the index in buf where this value's literal starts, or -1 when
	// the value was written in an earlier flush.
	pos     int
	flushID int
}

func newSerializer() *serializer {
	return &serializer{
		strs:       map[string]*valueRef{},
		refs:       map[any]*valueRef{},
		inProgress: map[any]bool{},
	}
}

// scopeFlush is one scope's contribution to a resume payload.
type scopeFlush struct {
	id    int
	state *ScopeState
}

// fail records the first error encountered. Serialization continues so the
// caller gets one clean error rather than a partial panic.
func (s *serializer) fail(format string, args ...any) {
	if s.err == nil {
		s.err = fmt.Errorf(format, args...)
	}
}

// writeScopesRoot serializes a sorted list of scope flushes into the body of
// a resume array entry, choosing the arrow head LAST from wroteUndefined.
// Ports writeScopesRoot (html.mjs:647-694).
func (s *serializer) writeScopesRoot(flushes []scopeFlush) (string, error) {
	s.buf = s.buf[:0]
	s.wroteUndefined = false

	nextSlotID := -1
	for _, f := range flushes {
		openIndex := len(s.buf)
		s.buf = append(s.buf, "")
		if s.writeObjectProps(f.state) {
			if nextSlotID == -1 {
				s.buf[openIndex] = "[" + strconv.Itoa(f.id) + ",{"
			} else {
				delta := ""
				if f.id != nextSlotID {
					// Gap of g emits g-1: the decoder already advances
					// by one per entry.
					delta = "," + strconv.Itoa(f.id-nextSlotID)
				}
				s.buf[openIndex] = delta + ",{"
			}
			nextSlotID = f.id + 1
			s.buf = append(s.buf, "}")
		} else {
			// A scope whose props all failed to serialize -- or which had
			// none -- vanishes from the payload entirely.
			s.buf = s.buf[:openIndex]
		}
	}
	if nextSlotID != -1 {
		s.buf = append(s.buf, "]")
	}

	if s.err != nil {
		return "", s.err
	}

	result := strings.Join(s.buf, "")
	if result == "" {
		return "", nil
	}
	if s.wroteUndefined {
		s.wroteUndefined = false
		return "(_,$)=>" + result, nil
	}
	return "_=>" + result, nil
}

// writeObjectProps writes `k:v` pairs and reports whether at least one
// property made it out. A property whose value cannot be serialized is
// omitted, and the separator bookkeeping makes that seamless.
func (s *serializer) writeObjectProps(state *ScopeState) bool {
	sep := ""
	for _, key := range state.Keys() {
		val, _ := state.Get(key)
		mark := len(s.buf)
		s.buf = append(s.buf, sep+toObjectKey(key)+":")
		if s.writeValue(val) {
			sep = ","
		} else {
			s.buf = s.buf[:mark]
		}
	}
	return sep != ""
}

// writeValue writes one value and reports whether it produced output. A false
// return means the caller must drop the slot it had already opened --
// `undefined` in object position is the normal case.
func (s *serializer) writeValue(val any) bool {
	switch v := val.(type) {
	case nil:
		s.buf = append(s.buf, "null")
		return true
	case undefinedType:
		return false
	case bool:
		if v {
			s.buf = append(s.buf, "!0")
		} else {
			s.buf = append(s.buf, "!1")
		}
		return true
	case string:
		return s.writeString(v)
	case ScopeRef:
		// Scopes are never hoisted into a `_.x` slot; they re-emit as
		// `_(id)` every time. Forward references are fine because the
		// decoder creates scopes lazily.
		s.buf = append(s.buf, "_("+strconv.Itoa(v.ID)+")")
		return true
	case *ScopeState:
		return s.writeReferenceOr(v, func() bool { return s.writeNestedObject(v) })
	case []any:
		return s.writeReferenceOr(v, func() bool { return s.writeArray(v) })
	}

	if n, ok := numericValue(val); ok {
		s.buf = append(s.buf, formatJSNumber(n))
		return true
	}

	s.fail("runtime: unsupported serialized type %T in resume state", val)
	return false
}

// writeString writes a quoted string, deduping only when it is longer than
// stringDedupLength. Length is measured in UTF-16 code units, matching JS
// `val.length`.
func (s *serializer) writeString(val string) bool {
	if utf16Len(val) > stringDedupLength {
		if ref, ok := s.strs[val]; ok {
			s.buf = append(s.buf, s.ensureID(ref))
			return true
		}
		s.strs[val] = &valueRef{pos: len(s.buf), flushID: s.flushID}
	}
	s.buf = append(s.buf, quoteJS(val))
	return true
}

// writeReferenceOr implements the dedup protocol: literal at first use,
// `_.x` reference thereafter, with the assignment spliced retroactively in
// front of the already-written literal.
func (s *serializer) writeReferenceOr(val any, write func() bool) bool {
	key := refKeyOf(val)
	if ref, ok := s.refs[key]; ok {
		if s.inProgress[key] {
			// The value is reachable from its own ancestor chain. Marko
			// handles this with post-construction fixups (contract sec 7);
			// wave 1 rejects it instead.
			s.fail("runtime: cyclic value in resume state is not supported")
			return false
		}
		s.buf = append(s.buf, s.ensureID(ref))
		return true
	}

	ref := &valueRef{pos: len(s.buf), flushID: s.flushID}
	s.refs[key] = ref
	s.inProgress[key] = true
	ok := write()
	delete(s.inProgress, key)
	if !ok {
		delete(s.refs, key)
	}
	return ok
}

func (s *serializer) writeNestedObject(state *ScopeState) bool {
	s.buf = append(s.buf, "{")
	s.writeObjectProps(state)
	s.buf = append(s.buf, "}")
	return true
}

func (s *serializer) writeArray(vals []any) bool {
	s.buf = append(s.buf, "[")
	for i, v := range vals {
		if i > 0 {
			s.buf = append(s.buf, ",")
		}
		mark := len(s.buf)
		if !s.writeValue(v) {
			// Array holes are POSITIONAL, so undefined cannot simply be
			// dropped -- it becomes `$`, the arrow's never-passed second
			// parameter, and that in turn forces the `(_,$)=>` head.
			s.buf = s.buf[:mark]
			s.buf = append(s.buf, "$")
			s.wroteUndefined = true
		}
	}
	s.buf = append(s.buf, "]")
	return true
}

// ensureID returns the reference expression for a value, allocating and
// back-patching its assignment on first reuse.
func (s *serializer) ensureID(ref *valueRef) string {
	if ref.id != "" {
		return ref.id
	}
	return s.assignID(ref)
}

// assignID allocates a reference slot and splices `_.x=` in front of the
// literal that was already written. This is the back-patch the chunk buffer
// exists for; after joining, the reader just sees `a:_.a={v:1},b:_.a`.
func (s *serializer) assignID(ref *valueRef) string {
	ref.id = "_." + s.nextID()
	if ref.pos >= 0 && ref.flushID == s.flushID {
		if ref.pos == 0 {
			s.buf[0] = ref.id + "=" + s.buf[0]
		} else {
			s.buf[ref.pos-1] += ref.id + "="
		}
		return ref.id
	}
	// Cross-flush reuse would need an access path rebuilt from the parent
	// chain. Wave 1 renders in a single flush, so this is unreachable.
	s.fail("runtime: cross-flush value reuse is not supported")
	return ref.id
}

// nextID allocates the next reference slot name. Note the asymmetric
// arithmetic: `% 53` for the first character, `& 63` for the rest.
func (s *serializer) nextID() string {
	n := s.ids
	s.ids++
	r := string(refIDAlphabet[n%53])
	for n = n / 53; n != 0; n >>= 6 {
		r += string(refIDAlphabet[n&63])
	}
	return r
}

// numericValue narrows the Go numeric types generated code can produce to a
// float64 for JS-compatible formatting.
func numericValue(val any) (float64, bool) {
	switch v := val.(type) {
	case int:
		return float64(v), true
	case int8:
		return float64(v), true
	case int16:
		return float64(v), true
	case int32:
		return float64(v), true
	case int64:
		return float64(v), true
	case uint:
		return float64(v), true
	case uint8:
		return float64(v), true
	case uint16:
		return float64(v), true
	case uint32:
		return float64(v), true
	case uint64:
		return float64(v), true
	case float32:
		return float64(v), true
	case float64:
		return v, true
	}
	return 0, false
}

// refKeyOf derives a map key with pointer identity semantics, so two
// structurally equal but distinct values are NOT deduped -- matching the JS
// WeakMap. Pointers are already comparable by identity; slices are not, so
// they are keyed by their backing array pointer plus length.
func refKeyOf(val any) any {
	switch v := val.(type) {
	case *ScopeState:
		return v
	case []any:
		if len(v) == 0 {
			// Distinct empty slices share no backing array to compare, so
			// give each one a fresh identity rather than merging them.
			return new(int)
		}
		return sliceKey{first: &v[0], len: len(v)}
	}
	return val
}

type sliceKey struct {
	first *any
	len   int
}

// utf16Len returns the JS `.length` of a string: its UTF-16 code-unit count.
func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		if r > 0xFFFF {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// toObjectKey renders a property name, emitting it bare when JS allows.
// Ports toObjectKey (html.mjs:1588-1610).
func toObjectKey(name string) string {
	if name == "" {
		return `""`
	}
	if isIdentifierName(name) {
		return name
	}
	if isCanonicalIndex(name) {
		return name
	}
	if name == "__proto__" {
		// A bare `__proto__:` would set the prototype instead of defining a
		// property, so it always takes the computed form.
		return `["__proto__"]`
	}
	return quoteJS(name)
}

func isIdentifierName(name string) bool {
	for i := 0; i < len(name); i++ {
		c := name[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c == '_', c == '$':
		case i > 0 && c >= '0' && c <= '9':
		default:
			return false
		}
	}
	return name != "__proto__"
}

// isCanonicalIndex reports whether name is a run of digits that round-trips
// through JS number formatting, which is what lets it stay unquoted.
func isCanonicalIndex(name string) bool {
	if name == "0" {
		return true
	}
	if name[0] == '0' {
		return false
	}
	for i := 0; i < len(name); i++ {
		if name[i] < '0' || name[i] > '9' {
			return false
		}
	}
	if len(name) <= 15 {
		return true
	}
	n, err := strconv.ParseFloat(name, 64)
	if err != nil {
		return false
	}
	return formatJSNumber(n) == name
}

// quoteJS renders a JS double-quoted string literal using the serializer's
// deliberately minimal escape set (quote, html.mjs:1613-1660).
//
// Only `"`, `\`, `<`, LF, CR, U+2028, U+2029, NUL and lone surrogates are
// escaped. EVERYTHING else goes out literally -- single quotes, tabs, other
// control characters, all non-ASCII, and valid surrogate pairs (emoji pass
// through as raw UTF-8).
//
// `<` becoming `\x3C` is what makes `</script>` safe by construction; there
// is no separate `</script>` case.
func quoteJS(val string) string {
	var b strings.Builder
	b.WriteByte('"')
	for i := 0; i < len(val); {
		r, size := utf8.DecodeRuneInString(val[i:])
		if r == utf8.RuneError && size == 1 {
			// Not valid UTF-8. Go strings can carry WTF-8 encoded lone
			// surrogates, which JS represents natively; decode and escape.
			if cp, n, ok := decodeSurrogate(val[i:]); ok {
				b.WriteString(`\u`)
				b.WriteString(strconv.FormatInt(int64(cp), 16))
				i += n
				continue
			}
			b.WriteByte(val[i])
			i++
			continue
		}
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '<':
			b.WriteString(`\x3C`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case 0:
			b.WriteString(`\x00`)
		case 0x2028:
			b.WriteString(`\u2028`)
		case 0x2029:
			b.WriteString(`\u2029`)
		default:
			b.WriteRune(r)
		}
		i += size
	}
	b.WriteByte('"')
	return b.String()
}

// decodeSurrogate decodes a WTF-8 encoded lone surrogate (3 bytes in the
// D800-DFFF range) from the front of s.
func decodeSurrogate(s string) (rune, int, bool) {
	if len(s) < 3 {
		return 0, 0, false
	}
	b0, b1, b2 := s[0], s[1], s[2]
	if b0&0xF0 != 0xE0 || b1&0xC0 != 0x80 || b2&0xC0 != 0x80 {
		return 0, 0, false
	}
	cp := rune(b0&0x0F)<<12 | rune(b1&0x3F)<<6 | rune(b2&0x3F)
	if !utf16.IsSurrogate(cp) {
		return 0, 0, false
	}
	return cp, 3, true
}

// sortedScopeIDs returns the scope ids in ascending order. The JS side gets
// this for free from numeric-string object key ordering; Go must sort
// explicitly, and must, since delta encoding depends on it.
func sortedScopeIDs(scopes map[int]*ScopeState) []int {
	ids := make([]int, 0, len(scopes))
	for id := range scopes {
		ids = append(ids, id)
	}
	sort.Ints(ids)
	return ids
}
