package runtime

import "strings"

// This file ports Marko's attribute-rendering runtime
// (@marko/runtime-tags/src/html/attrs.ts and
// @marko/runtime-tags/src/common/helpers.ts, as built into
// dist/debug/html.js). Only the SSR-relevant subset is ported: no
// controlled-input/event-handler wiring (`_attrs`'s `input`/`select`/
// `textarea`/etc special-casing, `EventAttributes` bookkeeping), since this
// runtime never resumes/hydrates. Escaping and omission rules are matched
// exactly.

// A is one ordered attribute entry for Attrs: the Go target for an
// object-literal property inside a Marko `_attrs({...})` call
// (fr1-design.md, "`_attrs({...}, ...)` inside `_html` template literal").
type A struct {
	Name  string
	Value any
}

// EscapeAttr escapes val for use inside a double-quoted HTML attribute
// value. Port of the value-escaping half of Marko's `nonVoidAttr`/
// `attrAssignment` (src/html/attrs.ts): unlike Escape (text content), `"`
// is escaped and `<` is NOT. `val + ""` (JS string coercion) is applied
// first via toJSString.
//
//	const doubleQuoteAttrReplacements = /["\r]|&(?=[#a-zA-Z])/g;
//	function replaceUnsafeDoubleQuoteAttrChar(match) {
//	  return match === '"' ? "&#34;" : match === "\r" ? "&#13;" : "&amp;";
//	}
//
// This always escapes for double-quoting (Marko's real quote choice is
// dynamic -- see attrAssignment below, which switches to single-quoting
// and a different replacement set when the value's first "needs quoting"
// character is `"`). EscapeAttr on its own is the double-quote-value
// escaper; callers that need Marko's exact quote-selection behavior go
// through Attr/AttrClass/AttrStyle, which call attrAssignment.
func EscapeAttr(val any) string {
	return escapeDoubleQuotedAttrValue(toJSString(val))
}

func escapeDoubleQuotedAttrValue(s string) string {
	if !needsAttrEscape(s, '"') {
		return s
	}
	return replaceAttrEscape(s, '"', "&#34;")
}

// escapeSingleQuotedAttrValue is the port of escapeSingleQuotedAttrValue:
// same idea as escapeDoubleQuotedAttrValue but escapes `'` instead of `"`.
//
//	const singleQuoteAttrReplacements = /['\r]|&(?=[#a-zA-Z])/g;
//	function replaceUnsafeSingleQuoteAttrChar(match) {
//	  return match === "'" ? "&#39;" : match === "\r" ? "&#13;" : "&amp;";
//	}
func escapeSingleQuotedAttrValue(s string) string {
	if !needsAttrEscape(s, '\'') {
		return s
	}
	return replaceAttrEscape(s, '\'', "&#39;")
}

// needsAttrEscape mirrors the JS test `/["\r]|&(?=[#a-zA-Z])/` (or the
// single-quote variant, when quoteChar is a single quote).
func needsAttrEscape(s string, quoteChar byte) bool {
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == quoteChar || c == '\r' {
			return true
		}
		if c == '&' && isAmpEntityStart(s, i+1) {
			return true
		}
	}
	return false
}

// replaceAttrEscape applies the quoteChar/`\r`/`&amp;`-entity replacement
// shared by escapeDoubleQuotedAttrValue and escapeSingleQuotedAttrValue.
func replaceAttrEscape(s string, quoteChar byte, quoteReplacement string) string {
	var b strings.Builder
	b.Grow(len(s) + 8)
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == quoteChar:
			b.WriteString(quoteReplacement)
		case c == '\r':
			b.WriteString("&#13;")
		case c == '&' && isAmpEntityStart(s, i+1):
			b.WriteString("&amp;")
		default:
			b.WriteByte(c)
		}
	}
	return b.String()
}

// isAmpEntityStart reports whether s[i] (the byte right after an `&`) is
// `#` or an ASCII letter -- the lookahead in `&(?=[#a-zA-Z])`.
func isAmpEntityStart(s string, i int) bool {
	if i >= len(s) {
		return false
	}
	c := s[i]
	return c == '#' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

// attrAssignment is the Go port of Marko's attrAssignment: given an
// (already stringified) value, returns `=value`, `="escaped"`, or
// `='escaped'` -- bare (unquoted) when the value needs no quoting.
// Quote-character choice mirrors Marko's regex trick exactly: scan for the
// first character matching /["'>\s]|&[#a-zA-Z]|\/$/ (needsQuotedAttr); if
// that character is literally `"`, single-quote (so the `"` doesn't need
// escaping); otherwise double-quote. An empty value renders with no `=` at
// all (bare attribute name):
//
//	function attrAssignment(value) {
//	  return value ? needsQuotedAttr.test(value) ? value[needsQuotedAttr.lastIndex - 1] === (needsQuotedAttr.lastIndex = 0, '"')
//	    ? "='" + escapeSingleQuotedAttrValue(value) + "'"
//	    : "=\"" + escapeDoubleQuotedAttrValue(value) + "\""
//	    : "=" + value
//	    : "";
//	}
func attrAssignment(value string) string {
	if value == "" {
		return ""
	}
	if firstQuoteTrigger, ok := firstNeedsQuotedAttrChar(value); ok {
		if firstQuoteTrigger == '"' {
			return "='" + escapeSingleQuotedAttrValue(value) + "'"
		}
		return "=\"" + escapeDoubleQuotedAttrValue(value) + "\""
	}
	return "=" + value
}

// firstNeedsQuotedAttrChar mirrors /["'>\s]|&[#a-zA-Z]|\/$/'s first match,
// reporting the literal character that triggered it (so attrAssignment can
// test whether it was exactly `"`). A trailing `/` triggers the match too,
// but attrAssignment only cares about the `"` case, so the trailing-slash
// and other non-`"` triggers are reported as a sentinel that compares
// unequal to `"`.
func firstNeedsQuotedAttrChar(s string) (byte, bool) {
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch c {
		case '"', '\'', '>', ' ', '\t', '\n', '\r', '\f', '\v':
			return c, true
		}
		if c == '&' && isAmpEntityStart(s, i+1) {
			return '&', true
		}
	}
	if len(s) > 0 && s[len(s)-1] == '/' {
		return '/', true
	}
	return 0, false
}

// nonVoidAttr is the Go port of Marko's nonVoidAttr (src/html/attrs.ts):
// value must already be known non-void (not nil, not false).
//
//	function nonVoidAttr(name, value) {
//	  switch (typeof value) {
//	    case "string": return " " + name + attrAssignment(value);
//	    case "boolean": return " " + name;
//	    case "number": return " " + name + "=" + value;
//	  }
//	  return " " + name + attrAssignment(value + "");
//	}
func nonVoidAttr(name string, value any) string {
	switch v := value.(type) {
	case string:
		return " " + name + attrAssignment(v)
	case bool:
		// Only reachable for `true`; `false` is void and filtered earlier.
		return " " + name
	case int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64, float32, float64:
		return " " + name + "=" + toJSString(v)
	default:
		return " " + name + attrAssignment(toJSString(v))
	}
}

// Attr is the Go target for Marko's `_attr(name, value)`: renders a single
// ` name="escaped"` attribute (or a bare ` name` boolean attribute, or ""
// for void values). Port of:
//
//	function _attr(name, value) {
//	  return isVoid(value) ? "" : nonVoidAttr(name, value);
//	}
//	function isVoid(value) {
//	  return value == null || value === false;
//	}
//
// Note the asymmetry with Escape (text content): here `0` and `""` are NOT
// special-cased and are NOT omitted -- only `nil` and `false` are void.
// A number renders unquoted, e.g. `name=0` (nonVoidAttr's number case). An
// empty string renders as a bare ` name` with no `=` at all, since
// attrAssignment("") returns "".
func Attr(name string, value any) string {
	if isVoidAttr(value) {
		return ""
	}
	return nonVoidAttr(name, value)
}

// isVoidAttr ports isVoid(value): value == null || value === false.
func isVoidAttr(value any) bool {
	if value == nil {
		return true
	}
	// `undefined` is `== null` in JS, so it is void here too. This is what an
	// omitted optional attribute reaches us as; see runtime.Absent.
	if _, ok := value.(undefinedType); ok {
		return true
	}
	if b, ok := value.(bool); ok {
		return !b
	}
	return false
}

// AttrClass is the Go target for Marko's `_attr_class(value)`: renders
// ` class="..."` or "". Port of:
//
//	function _attr_class(value) {
//	  return stringAttr("class", toDelimitedString(value, " ", stringifyClassObject));
//	}
//	function stringAttr(name, value) {
//	  return value && " " + name + attrAssignment(value);
//	}
//	function stringifyClassObject(name, value) {
//	  return value ? name : "";
//	}
//
// value may be: a string (used verbatim as one token); a []any (joined
// with " ", falsy entries skipped, recursively delimited); or a
// map[string]any (keys with a truthy value are included, in map-iteration
// order -- see Attrs for the ordering caveat on map inputs).
func AttrClass(value any) string {
	return stringAttrOut("class", toDelimitedString(value, " ", stringifyClassEntry))
}

func stringifyClassEntry(name string, value any) string {
	if Truthy(value) {
		return name
	}
	return ""
}

// AttrStyle is the Go target for Marko's `_attr_style(value)`: renders
// ` style="..."` or "". Port of:
//
//	function _attr_style(value) {
//	  return stringAttr("style", toDelimitedString(value, ";", stringifyStyleObject));
//	}
//	function stringifyStyleObject(name, value) {
//	  return value || value === 0 ? escapeStyleAttr(name) + ":" + escapeStyleAttr(value + "") : "";
//	}
//
// value may be: a string (used verbatim); a []any (";"-joined, falsy
// entries skipped); or a map[string]any (keys with a truthy value, or the
// number 0, included as `key:value`).
func AttrStyle(value any) string {
	return stringAttrOut("style", toDelimitedString(value, ";", stringifyStyleEntry))
}

func stringifyStyleEntry(name string, value any) string {
	if Truthy(value) || isZero(value) {
		return escapeStyleAttr(name) + ":" + escapeStyleAttr(toJSString(value))
	}
	return ""
}

var unsafeStyleAttrChars = "\\;"

// escapeStyleAttr ports escapeStyleAttr: only `\` and `;` are escaped,
// used for both style property names and values as rendered by
// stringifyStyleObject.
func escapeStyleAttr(s string) string {
	if !strings.ContainsAny(s, unsafeStyleAttrChars) {
		return s
	}
	var b strings.Builder
	b.Grow(len(s) + 4)
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case ';':
			b.WriteString("\\3B ")
		case '\\':
			b.WriteString("\\\\")
		default:
			b.WriteByte(s[i])
		}
	}
	return b.String()
}

// stringAttrOut ports stringAttr(name, value): value && " " + name +
// attrAssignment(value) -- an empty delimited string renders nothing.
func stringAttrOut(name, value string) string {
	if value == "" {
		return ""
	}
	return " " + name + attrAssignment(value)
}

// toDelimitedString ports toDelimitedString(val, delimiter, stringify)
// (src/common/helpers.ts): joins a string/slice/map value into a single
// delimited string, dropping falsy parts.
//
//	const toDelimitedString = function (val, delimiter, stringify) {
//	  let str = "", sep = "", part;
//	  if (val) if (typeof val !== "object") str += val;
//	  else if (Array.isArray(val)) for (const v of val) {
//	    part = toDelimitedString(v, delimiter, stringify);
//	    if (part) { str += sep + part; sep = delimiter; }
//	  }
//	  else for (const name in val) {
//	    part = stringify(name, val[name]);
//	    if (part) { str += sep + part; sep = delimiter; }
//	  }
//	  return str;
//	};
//
// map[string]any inputs have no defined JS insertion order in Go, so keys
// are visited in sorted order for determinism (see Attrs doc for the same
// rule applied to attribute spreads).
func toDelimitedString(val any, delimiter string, stringify func(name string, value any) string) string {
	if !Truthy(val) {
		return ""
	}
	switch v := val.(type) {
	case string:
		return v
	case []any:
		var b strings.Builder
		sep := ""
		for _, item := range v {
			part := toDelimitedString(item, delimiter, stringify)
			if part != "" {
				b.WriteString(sep)
				b.WriteString(part)
				sep = delimiter
			}
		}
		return b.String()
	case map[string]any:
		keys := make([]string, 0, len(v))
		for k := range v {
			keys = append(keys, k)
		}
		sortStrings(keys)
		var b strings.Builder
		sep := ""
		for _, k := range keys {
			part := stringify(k, v[k])
			if part != "" {
				b.WriteString(sep)
				b.WriteString(part)
				sep = delimiter
			}
		}
		return b.String()
	default:
		// Numbers, bools (true, since falsy already returned above), etc:
		// JS `str += val` coerces via string concatenation.
		return toJSString(v)
	}
}

// isEventHandlerName mirrors isEventHandler: /^on[A-Z-]/. Event-handler-ish
// attribute keys are SSR-inert (they wire up client-side hydration, which
// this runtime doesn't support) and are dropped, matching fr1-design.md's
// "event-handler-ish keys can be ignored (SSR-only)".
func isEventHandlerName(name string) bool {
	if len(name) < 3 || name[0] != 'o' || name[1] != 'n' {
		return false
	}
	c := name[2]
	return c == '-' || (c >= 'A' && c <= 'Z')
}

// Attrs is the Go target for Marko's `_attrs({...}, ...)` call inside an
// `_html` template literal (fr1-design.md: "`_attrs({...}, ...)` inside
// `_html` template literal"). Each item is either:
//
//   - runtime.A{Name, Value}: one ordered attribute (from an object-literal
//     property in the original `_attrs({...})` call);
//   - map[string]any: a spread (`...expr`), merged into the accumulating
//     ordered attribute set the way a JS object spread would merge into an
//     object literal -- later items win on name collision, and an
//     overridden name keeps the position of its *first* appearance (JS
//     object semantics: re-assigning an existing key doesn't move it).
//
// `class` and `style` keys route through AttrClass/AttrStyle instead of
// Attr. Event-handler-ish names (isEventHandlerName) are skipped (SSR-only
// runtime, no hydration). Void values (nil, false) are omitted; see Attr.
//
// Because a map[string]any has no defined iteration order, keys introduced
// *by* a given map item (i.e. not already present from an earlier item)
// are visited in sorted order for deterministic output -- this only
// affects the *relative order among that map's own new keys*; it does not
// change override values or the position rule above.
func Attrs(items ...any) string {
	type entry struct {
		name  string
		value any
	}
	var order []string
	values := make(map[string]any)

	set := func(name string, value any) {
		if _, exists := values[name]; !exists {
			order = append(order, name)
		}
		values[name] = value
	}

	for _, item := range items {
		switch v := item.(type) {
		case A:
			set(v.Name, v.Value)
		case map[string]any:
			keys := make([]string, 0, len(v))
			for k := range v {
				keys = append(keys, k)
			}
			sortStrings(keys)
			for _, k := range keys {
				set(k, v[k])
			}
		}
	}

	var b strings.Builder
	for _, name := range order {
		value := values[name]
		switch {
		case name == "class":
			b.WriteString(AttrClass(value))
		case name == "style":
			b.WriteString(AttrStyle(value))
		case isEventHandlerName(name):
			// SSR-only runtime: drop event handlers, no scope to wire up.
		default:
			b.WriteString(Attr(name, value))
		}
	}
	return b.String()
}

// sortStrings sorts a []string in place (ascending, byte-wise). Small local
// helper to avoid pulling in "sort" for a single call site... actually just
// use sort.Strings; kept as a named wrapper for doc clarity at call sites.
func sortStrings(s []string) {
	// insertion sort is fine: attribute counts are tiny.
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j-1] > s[j]; j-- {
			s[j-1], s[j] = s[j], s[j-1]
		}
	}
}
