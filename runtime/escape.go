package runtime

import "strings"

// Escape renders val as escaped text content. It is a byte-for-byte port
// of Marko's `_escape` (@marko/runtime-tags/src/html/content.ts):
//
//	export function _escape(val: unknown) {
//	  return val ? escapeXMLStr(val + "") : val === 0 ? "0" : "";
//	}
//
// This is a *text-node* escaper, not an attribute-value escaper: only
// `<`, `&`, and `\r` are escaped. `>` and quotes are deliberately left
// alone, matching the HTML spec's rules for text content. Attribute
// escaping (Marko's `_attr`/`_attr_class`/etc.) is not yet ported -- see
// "Known gaps" in PLAN.md.
func Escape(val any) string {
	if isFalsy(val) {
		if isZero(val) {
			return "0"
		}
		return ""
	}
	return escapeXML(toJSString(val))
}

func escapeXML(s string) string {
	if !strings.ContainsAny(s, "<&\r") {
		return s
	}
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		switch r {
		case '&':
			b.WriteString("&amp;")
		case '<':
			b.WriteString("&lt;")
		case '\r':
			b.WriteString("&#13;")
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}
