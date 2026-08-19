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

	// effects is the script-entry token stream; lastEffect tracks the
	// current registry id so consecutive entries with the same id collapse.
	effects      string
	lastEffect   string
	hasEffect    bool
	needsRuntime bool

	ser *serializer
	err error
}

func newResumeState() *resumeState {
	return &resumeState{
		runtimeID:   DefaultRuntimeID,
		renderID:    DefaultRenderID,
		writeScopes: map[int]*ScopeState{},
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

// FlushResume writes the resume payload script into the output stream and
// then appends any buffered trailer markup, completing the render.
//
// This is the Phase C integration point. Generated code -- or marko.Handler
// on its behalf -- must call it exactly once, after the last markup write:
//
//	func Page(w *runtime.Writer, input PageInput) {
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
	w.flushTrailers()
	return nil
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
