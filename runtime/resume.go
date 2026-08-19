package runtime

import (
	"regexp"
	"strconv"
	"strings"
)

// bootstrapRuntimeCode is the walker runtime prelude, emitted at most once per
// render. In production Marko this is a hardcoded string constant with the
// runtime and render ids interpolated; it never varies at the pinned version
// (@marko/runtime-tags 6.3.42) except for those two ids.
const bootstrapRuntimeCode = `(e=>(self[e]||=(l,f=e+l,s=f.length,a={},d=[],t=document,n=t.createTreeWalker(t,129))=>t=self[e][l]={i:f,d:t,l:a,v:d,x(){},w(e,l,r){for(;e=n.nextNode();)t.x(l=(l=e.data)&&!l.indexOf(f)&&(a[r=l.slice(s+1)]=e,l[s]),r,e),l>"#"&&d.push(e)}},self[e]))`

// idPattern is the validation Marko's render() applies to runtimeId and
// renderId before interpolating them UNESCAPED into the bootstrap. Go applies
// the same rule so the payload cannot be broken by a bad id.
var idPattern = regexp.MustCompile(`^[_a-zA-Z][_a-zA-Z0-9]*$`)

// Default runtime and render ids. "M" is always the runtime id; "_" is the
// render id for PAGE templates, which is all go-marko renders. (An embedded
// template would get a random render id, losing byte-determinism.)
const (
	DefaultRuntimeID = "M"
	DefaultRenderID  = "_"
)

// Resume op codes. Only OpResume is needed for flat reactive templates; the
// branch ops arrive with <if>/<for> and the reorder ops with streaming.
//
// Resume support; generated code only; not stable.
const (
	// OpResume ("*") binds the preceding sibling node into scope[accessor].
	OpResume = "*"
)

// resumeState is the Writer's resume channel: the scope partials, effects
// string and flags accumulated during markup emission, plus the serializer
// that turns them into payload bytes at flush time.
type resumeState struct {
	runtimeID string
	renderID  string

	// writeScopes accumulates per-scope partials, MERGED rather than
	// replaced when the same id is written more than once.
	writeScopes map[int]*ScopeState

	// nextScopeID is the render's scope-id allocator. 1-based: 0 is $global.
	nextScopeID int

	// effects is the script-entry token stream; lastEffect tracks the
	// current registry id so consecutive entries with the same id collapse.
	effects      string
	lastEffect   string
	hasEffect    bool
	needsRuntime bool

	// clientBundle is the URL of this page's browser bundle, emitted as a
	// module script AFTER the payload script and BEFORE the trailers. See
	// Writer.ClientBundle.
	clientBundle string

	ser *serializer
	err error
}

// ClientBundle names the browser bundle for this page. FlushResume emits it as
//
//	<script type="module" src="URL"></script>
//
// immediately AFTER the resume payload script and BEFORE the trailers, which
// is the order a stock Marko app boots in: the payload defines M._.r and calls
// M._.w() synchronously, then the deferred module executes init() against the
// state that is already there.
//
// Generated code calls this only for PAGE templates that actually compile to
// non-empty dom output; a page with no reactivity ships no bundle.
//
// Resume support; generated code only; not stable.
func (w *Writer) ClientBundle(url string) {
	w.resume().clientBundle = url
}

func newResumeState() *resumeState {
	return &resumeState{
		runtimeID:   DefaultRuntimeID,
		renderID:    DefaultRenderID,
		writeScopes: map[int]*ScopeState{},
		nextScopeID: 1,
		ser:         newSerializer(),
	}
}

// SetResumeIDs overrides the runtime and render ids used for the bootstrap,
// the runtime prefix and the marker comments. Both must match
// /^[_a-zA-Z][_a-zA-Z0-9]*$/, because they are interpolated into the payload
// unescaped; an invalid id is recorded as a render error.
//
// The defaults ("M" and "_") are what a Marko page template produces, so most
// renders never need this.
//
// Resume support; generated code only; not stable.
func (w *Writer) SetResumeIDs(runtimeID, renderID string) {
	r := w.resume()
	if !idPattern.MatchString(runtimeID) || !idPattern.MatchString(renderID) {
		if r.err == nil {
			r.err = errInvalidResumeID
		}
		return
	}
	r.runtimeID = runtimeID
	r.renderID = renderID
}

// resume lazily creates the resume channel, so a render that never touches
// resumability pays nothing.
func (w *Writer) resume() *resumeState {
	if w.res == nil {
		w.res = newResumeState()
	}
	return w.res
}

// AllocScopeID allocates the next scope id for this render, mirroring the JS
// `_scope_id()` intrinsic (a post-increment of a per-render counter).
//
// Ids are 1-BASED -- 0 is reserved for $global -- and allocation ORDER is part
// of the wire format, because the ids appear in markers, in scope references
// and in the ascending delta encoding of the payload. Generated code must
// therefore call this exactly where the compiled JS calls `_scope_id()`,
// including inside body closures and conditional branches: allocation order is
// render order, not source order.
//
// Resume support; generated code only; not stable.
func (w *Writer) AllocScopeID() int {
	r := w.resume()
	id := r.nextScopeID
	r.nextScopeID++
	return id
}

// PeekScopeID returns the id AllocScopeID would hand out next, without
// consuming it. Mirrors the JS `_peek_scope_id()` intrinsic, which the
// compiler uses to name a child scope that a callee is about to allocate.
//
// Resume support; generated code only; not stable.
func (w *Writer) PeekScopeID() int {
	return w.resume().nextScopeID
}

// TouchScope records that a scope EXISTS without giving it any state, mirroring
// the JS `_existing_scope(id)` intrinsic (`writeScope(id, {})`).
//
// A scope with no properties is skipped by the serializer, so on its own this
// writes nothing to the payload -- but a later AddScope for the same id merges
// into it, and it marks the render as needing the resume runtime.
//
// Resume support; generated code only; not stable.
func (w *Writer) TouchScope(id int) ScopeRef {
	w.AddScope(id, NewScopeState())
	return ScopeRef{ID: id}
}

// AddScope records serialized state for a scope id. Repeated calls for the
// same id MERGE their properties rather than replacing them, matching the JS
// writer.
//
// Scope id 0 is $global; ids for template scopes start at 1.
//
// Resume support; generated code only; not stable.
func (w *Writer) AddScope(id int, state *ScopeState) {
	r := w.resume()
	r.needsRuntime = true
	if existing, ok := r.writeScopes[id]; ok {
		existing.merge(state)
		return
	}
	merged := NewScopeState()
	merged.merge(state)
	r.writeScopes[id] = merged
}

// AddScript records a script (effect) entry binding a registry id to a scope
// id. Entries are emitted in CALL ORDER, and consecutive entries sharing a
// registry id collapse: AddScript(1,"R1"), AddScript(2,"R1"), AddScript(3,"R2")
// produces "R1 1 2 R2 3".
//
// The registry id must be non-numeric -- the decoder distinguishes the two
// token kinds by testing for a non-digit.
//
// Resume support; generated code only; not stable.
func (w *Writer) AddScript(registryID string, scopeID int) {
	r := w.resume()
	r.needsRuntime = true
	r.hasEffect = true
	if r.lastEffect == registryID {
		r.effects += " " + strconv.Itoa(scopeID)
		return
	}
	r.lastEffect = registryID
	entry := registryID + " " + strconv.Itoa(scopeID)
	if r.effects == "" {
		r.effects = entry
	} else {
		r.effects += " " + entry
	}
}

// Marker writes a resume marker comment into the HTML stream. Markers are
// placed IMMEDIATELY AFTER the node they name.
//
// The comment is `<!--{runtimeID}{renderID}{op}{scopeID} {accessor}-->`; the
// bootstrap's TreeWalker matches the id prefix and records the node under the
// accessor.
//
// Resume support; generated code only; not stable.
func (w *Writer) Marker(op string, scopeID int, accessor string) {
	r := w.resume()
	r.needsRuntime = true
	w.HTML("<!--" + r.runtimeID + r.renderID + op + strconv.Itoa(scopeID) + " " + accessor + "-->")
}

// Trailer buffers markup that must be written AFTER the resume payload
// script -- in practice the closing `</body></html>` of an <html> tag.
//
// Marko accumulates this separately (`_trailers`) precisely so the payload
// script can be spliced in ahead of it. Generated code should route its final
// closing-tag write here whenever the template has an <html> root; everything
// else keeps using HTML.
//
// Resume support; generated code only; not stable.
func (w *Writer) Trailer(s string) {
	w.trailers.WriteString(s)
}

// BeginTemplate marks the start of one template's render. Generated code emits
// it as the first statement of every render function, paired with FlushResume
// as the last.
//
// It exists because "which template flushes the resume payload?" is a RUNTIME
// question, not a compile-time one. Marko's compiler marks every non-embedded
// template `page` (the third argument to `_template`), so that flag cannot tell
// a page apart from a tag it calls -- in JS the distinction is simply which
// template `.render()` was invoked on. The Go analogue is depth: the outermost
// active render is the document, and it is the one that flushes.
//
// Resume support; generated code only; not stable.
func (w *Writer) BeginTemplate() {
	w.renderDepth++
}

// FlushResume closes one template's render. On the OUTERMOST call it writes the
// resume payload script, then the client bundle script, then any buffered
// trailer markup, completing the document; a nested call only decrements the
// depth and does nothing else, so a tag can never emit a payload mid-document.
//
// Generated code emits it as the last statement of every render function,
// paired with BeginTemplate as the first:
//
//	func Page(w *runtime.Writer, input PageInput) {
//	    w.BeginTemplate()
//	    w.HTML("<html><body>...")
//	    w.Marker(runtime.OpResume, 1, "a")
//	    w.AddScope(1, runtime.ScopeStateOf("c", 0))
//	    w.AddScript("WDGvDBz", 1)
//	    w.Trailer("</body></html>")
//	    w.FlushResume()
//	}
//
// A render with no resume state writes nothing at all -- not even an empty
// <script> -- so calling it unconditionally is safe and costs nothing.
//
// It returns the first error hit while serializing (an unsupported value type
// or a cycle). On error nothing is written, so the caller can surface a
// failure rather than shipping a corrupt payload.
//
// Resume support; generated code only; not stable.
func (w *Writer) FlushResume() error {
	if w.renderDepth > 0 {
		w.renderDepth--
		if w.renderDepth > 0 {
			return nil
		}
	}
	if w.res == nil {
		w.flushTrailers()
		return nil
	}
	r := w.res
	if r.err != nil {
		return r.err
	}

	scripts, err := r.buildScripts()
	if err != nil {
		return err
	}
	if scripts != "" {
		w.sb.WriteString("<script>")
		w.sb.WriteString(scripts)
		w.sb.WriteString("</script>")
	}
	// The browser bundle loads AFTER the payload: init() needs M._.r to
	// already exist. Emitted only when a bundle was named -- a page with no
	// client code, and every byte-oracle comparison, sees nothing here.
	if r.clientBundle != "" {
		w.sb.WriteString(`<script type="module" src="`)
		w.sb.WriteString(EscapeAttr(r.clientBundle))
		w.sb.WriteString(`"></script>`)
	}
	w.flushTrailers()
	return nil
}

// EndTemplate is FlushResume for generated code, which has no way to return an
// error: render functions are `func(*Writer, Input)`, deliberately, so a
// template call reads like a statement.
//
// On a serialization failure it PANICS, naming the template. That is the loud
// end of the spectrum on purpose: the alternative -- swallowing the error --
// ships a page whose HTML looks right and whose interactivity is silently dead,
// which is the worst possible failure mode for a resumability feature. A
// panic surfaces in the http handler's recover, in tests, and in dev, and the
// only way to reach one is a value type the payload cannot express (an
// unsupported Go type in `<let>` state, or a cycle), which is a template bug.
//
// OPEN QUESTION for the error-model review: render functions returning an
// error, or an error accumulated on the Writer and surfaced by String(), would
// both be less violent. Neither fits the current `func(*Writer, Input)` shape,
// so this is deliberately a placeholder with a loud failure rather than a
// quiet one. See the Phase C report.
//
// Resume support; generated code only; not stable.
func (w *Writer) EndTemplate(templateName string) {
	if err := w.FlushResume(); err != nil {
		panic("marko-go: rendering " + templateName + ": " + err.Error())
	}
}

func (w *Writer) flushTrailers() {
	if w.trailers.Len() > 0 {
		w.sb.WriteString(w.trailers.String())
		w.trailers.Reset()
	}
}

// buildScripts assembles the `;`-joined script body: the bootstrap prelude,
// the resume array, and the kick-off call.
func (r *resumeState) buildScripts() (string, error) {
	flushes := make([]scopeFlush, 0, len(r.writeScopes))
	for _, id := range sortedScopeIDs(r.writeScopes) {
		state := r.writeScopes[id]
		// A scope with no own properties is skipped entirely.
		if state.Len() == 0 {
			continue
		}
		flushes = append(flushes, scopeFlush{id: id, state: state})
	}

	resumes, err := r.ser.writeScopesRoot(flushes)
	if err != nil {
		return "", err
	}

	// The effects string is ALWAYS the last element of the resume array,
	// regardless of the order scopes and scripts were recorded in.
	if r.hasEffect {
		if resumes != "" {
			resumes += ","
		}
		resumes += `"` + r.effects + `"`
	}

	if resumes == "" && !r.needsRuntime {
		return "", nil
	}
	if resumes == "" {
		// Markers were emitted but nothing serialized: no script at all.
		return "", nil
	}

	var parts []string
	parts = append(parts, bootstrapRuntimeCode+`("`+r.runtimeID+`")("`+r.renderID+`")`)
	prefix := r.runtimeID + "." + r.renderID
	parts = append(parts, prefix+".r=["+resumes+"]")
	// The kick-off is NOT unconditional: it is emitted only when this flush
	// produced an effects string. A payload of markers and scope data alone
	// does not walk.
	if r.hasEffect {
		parts = append(parts, prefix+".w()")
	}
	return strings.Join(parts, ";"), nil
}
