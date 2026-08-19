// Package runtime is the Go rendering target for marko-go. It implements a
// deliberately small subset of Marko's HTML writer
// (@marko/runtime-tags/src/html/writer.ts): synchronous, buffered, no
// streaming, no resumability/scope-tracking, no <await>. See PLAN.md
// for why.
package runtime

import "strings"

// Writer accumulates HTML output. It is the Go analogue of Marko's `_html`
// write target, minus the async/streaming machinery -- everything here is
// synchronous string concatenation.
type Writer struct {
	sb strings.Builder
}

// New returns an empty Writer.
func New() *Writer {
	return &Writer{}
}

// HTML writes a raw string with no escaping. Generated code only ever
// passes compile-time-known markup fragments here (the literal HTML from
// the .marko source); dynamic values must go through Escape first.
func (w *Writer) HTML(s string) {
	w.sb.WriteString(s)
}

// String returns everything written so far.
func (w *Writer) String() string {
	return w.sb.String()
}
