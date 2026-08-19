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
	sb      strings.Builder
	globals any
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

// SetGlobals attaches the request-scoped globals for this render. It is the
// Go analogue of Marko's `$global`: templates read it wherever the compiled
// JS reads `$global.<field>`.
//
// `v` should be the generated Globals struct for the project (package `ui`
// by convention, generated from the `Marko.Global` interface in a
// `global.d.ts`). Generated code retrieves it with a comma-ok type
// assertion, so a Writer with no globals -- or with globals of a different
// type -- renders with the ZERO VALUE rather than panicking. That's what
// keeps a plain `render(w, input)` call working with no setup.
//
// marko.WithGlobals wires this up for http handlers; call it directly when
// rendering outside an http handler.
func (w *Writer) SetGlobals(v any) {
	w.globals = v
}

// Globals returns the value set by SetGlobals, or nil if none was set.
func (w *Writer) Globals() any {
	return w.globals
}

// String returns everything written so far.
func (w *Writer) String() string {
	return w.sb.String()
}
