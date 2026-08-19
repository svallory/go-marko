# Known conformance divergences

Cases where the JS byte-oracle harness (`oracle.test.mjs`) found go-marko's
Go output and Marko's real JS `html` renderer legitimately disagree, today.
Each entry is either (a) SKIPPED with a reference here, or (b) normalized
via a documented, narrow transform in `helpers.mjs` -- never silently
tolerated by loosening the comparison itself. This file is the conformance
backlog architecture-guidance.md's "Contract problem" section asks the
golden+oracle+CI loop to surface.

## 1. attrs spread / map key order

**Fixture:** `ui/pages/attrs-spread.marko` (`attrs={ id: "main-panel",
"data-role": "container" }` spread onto `<panel ...input.attrs>`).

**Symptom:**

```
JS:  <div class=panel id=main-panel data-role=container>spread body</div>
Go:  <div class=panel data-role=container id=main-panel>spread body</div>
```

Same attribute set, different order.

**Root cause:** `attrs?: Marko.HTMLAttributes` is generated as
`map[string]any`, and Go maps have no defined iteration order. As already
documented in `runtime/attrs.go` (`Attrs`, `toDelimitedString`), the runtime
sorts spread keys alphabetically for deterministic output. JS objects
preserve source insertion order, so a spread literal with unsorted keys
renders in that source order instead.

**Status:** by design on the Go side (determinism > order fidelity for an
unordered map), but a real divergence from the JS reference renderer.
Closing it would mean generating an ORDERED representation for `attrs={...}`
object literals (e.g. a slice of key/value pairs, preserving source order)
instead of `map[string]any` -- worth doing before `Marko.HTMLAttributes`
leaves the "ported subset" stage, since attribute order is occasionally
significant to snapshot-testing consumers even though it's never
HTML-semantically significant.

**Test disposition:** `oracle.test.mjs`'s "attrs spread on custom tag" case
is `test.skip`, tagged `knownDivergence: "attrs spread / map key order"`,
referencing this entry.

## 2. ~~Optional `Marko.Body` content emits a resume-bootstrap tail~~ CLOSED

**Closed by FR12 wave 1, Phase C.** go-marko now emits the resume payload
itself, so there is nothing left to strip: `_el_resume`, `_scope`, `_script`
and `_trailers` are real translators (`codegen/src/resume.mjs`) feeding the
Writer's resume channel (`runtime/resume.go`).

`helpers.mjs`'s `RESUME_BOOTSTRAP_TAIL` regex and the per-case
`stripResumeBootstrap` flag are **deleted**; every oracle case now asserts the
FULL byte match, resume payload included, and `attrs-spread.marko` -- the
fixture that used to need the strip -- passes it.

One thing had to change for that to be possible. Registry ids (the `_script`
content hashes that appear verbatim in the payload) hash the template's
**absolute file path**, not its bytes (wire contract sec 15.1). The Go pipeline
generates from a temp module copy, so the JS oracle now compiles that same temp
copy rather than `fixtures/` -- `renderWithJsOracle` takes a fixture-RELATIVE
path and resolves it against the shared temp root. Rendering the two halves
from different paths produces payloads that differ only in ids, which is the
kind of false failure that would have made the whole suite untrustworthy.

## 3. Optional scalar attribute: `undefined` vs the Go zero value

**Fixture:** the quickstart's `ui-button.marko` (`target?: string`,
`class?: string`), reached from `reactive.marko` / `landing.marko`.

**Symptom (before the fix):**

```
JS:  <a href=/counter class="...">
Go:  <a href=/counter target class="...">
```

and, in the payload, `{h:"/counter",i:"",l:"",m:[...]}` where JS wrote
`{h:"/counter",m:[...]}`.

**Root cause:** Go has no "unset" for a scalar struct field, so marko-go's
generated Input structs use the ZERO VALUE to mean "attribute not passed"
(`inputstruct.mjs`). That is invisible while a template only makes rendering
DECISIONS from the field, but the wire distinguishes the two: JS receives
`undefined` for an omitted attribute and Marko drops it from both the markup
and the resume payload, while a real `""` renders as a bare attribute and
serializes as `""`.

**Status: fixed.** `runtime.Absent(v)` maps a Go zero value back to
`runtime.Undefined`, and generated code wraps every read of an OPTIONAL scalar
input field in the two places where the difference is observable: attribute
values and resume-payload values (including array elements, since a
`<const/classes=[...]>` array feeds both). `Attr`/`Attrs` treat `Undefined` as
void and the serializer drops it in object position / writes the positional `$`
hole in array position -- exactly JS's behaviour in each place.

The cost is the documented flip side of the zero-value convention: a template
that deliberately passes `target=""` is now indistinguishable from one that
omits it. That trade was already made by the Input struct shape; `Absent` only
makes both ends agree about which side of it we are on.

## 4. `runtime.String` collapses a falsy operand, losing `false` on the wire

**Fixture:** the quickstart's `navbar.marko`:
`class=($global.path === "/counter" && "bg-accent text-accent-foreground")`,
passed to `ui-button`'s `class?: string`.

**Symptom:** one byte pair in the resume payload, on all three quickstart
pages:

```
JS:  m:[_.a,_.b,"h-9 px-4 py-2",!1]
Go:  m:[_.a,_.b,"h-9 px-4 py-2",$]
```

`!1` is `false`; `$` is `undefined`. Everything else on those pages --
markup, markers, scope ids, deltas, script entries -- is byte-identical.

**Root cause:** JS `&&` returns an OPERAND, so an unmatched condition yields
`false`, and `false` is what gets serialized. The callee declares
`class?: string`, so the call site coerces with `runtime.String`, which is
documented to collapse ANY falsy value to `""` ("the Go zero value the field
would have held had the attribute been omitted entirely"). `Absent` then reads
that `""` as absent. The `false` is gone before the payload is built, and it
cannot be recovered without widening optional scalar Input fields to `any`.

**Impact:** none functionally. Both `false` and `undefined` are falsy to the
client, and `AttrClass` skips either -- the rendered class list is identical,
and hydration reads the same absence. It is a byte divergence in a value whose
only consumer treats the two identically.

**Status:** open, deliberately. Closing it means changing how optional scalar
Input fields are TYPED (`class?: string` -> `any`), which reaches well past
resumability into the whole Input-struct contract, and would make every
template that reads such a field pay a type assertion. Revisit alongside
divergence #1 (`attrs` ordering), which wants the same kind of
richer-value-representation change.

**Test disposition:** not covered by the golden/oracle fixtures (no fixture
passes a value-position `&&` into an optional string field); recorded here from
the Phase C quickstart byte-comparison.
