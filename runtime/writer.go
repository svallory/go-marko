// Package runtime is the Go rendering target for marko-go. It implements a
// deliberately small subset of Marko's HTML writer
// (@marko/runtime-tags/src/html/writer.ts): synchronous, buffered, no
// streaming, no <await>. See PLAN.md for why.
//
// Resumability is supported for the wave-1 subset: resume markers, scope
// state serialization and script entries, flushed as a byte-exact Marko 6
// resume payload. See resume.go for the API and notes/resume-wire-contract.md
// for the specification it implements.
package runtime

import (
	"errors"
	"strings"
)

// Writer accumulates HTML output. It is the Go analogue of Marko's `_html`
// write target, minus the async/streaming machinery -- everything here is
// synchronous string concatenation.
type Writer struct {
	sb      strings.Builder
	globals any

	// res is the resume channel, created lazily so a render that never uses
	// resumability pays nothing for it. See resume.go.
	res *resumeState
	// trailers buffers markup that must land AFTER the resume payload
	// script -- the closing `</body></html>`. See Writer.Trailer.
	trailers strings.Builder

	// renderDepth counts active template renders, so only the outermost one
	// flushes the resume payload. See Writer.BeginTemplate.
	renderDepth int
}

// errInvalidResumeID is returned by FlushResume when SetResumeIDs was given a
// runtime or render id that does not match /^[_a-zA-Z][_a-zA-Z0-9]*$/. The ids
// are interpolated into the payload unescaped, so this is enforced rather than
// escaped around.
var errInvalidResumeID = errors.New("runtime: runtime/render id must match /^[_a-zA-Z][_a-zA-Z0-9]*$/")

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

// String returns everything written so far, with any buffered trailer markup
// appended. Trailers are flushed here as a safety net for renders that never
// call FlushResume; calling FlushResume first is the normal path and makes
// this a plain read.
func (w *Writer) String() string {
	w.flushTrailers()
	return w.sb.String()
}
