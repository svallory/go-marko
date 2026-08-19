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

## 2. Optional `Marko.Body` content emits a resume-bootstrap tail (JS side only)

**Fixture:** `ui/pages/attrs-spread.marko` (same fixture as #1 --
`content?: Marko.Body` on `panel.marko`, populated by the caller).

**Symptom:** the JS renderer appends, after otherwise-identical markup:

```html
<!--M_*2 a--><script>(e=>(self[e]||=...))("M")("_");M._.r=["<hash> 2"];M._.w()</script>
```

go-marko emits nothing here -- by design, it drops all resume/scope
bookkeeping (see `transpile.mjs`'s `RESUME_ONLY` set and
`notes/fr12-resume-findings.md`).

**Root cause:** Marko 6's dynamic-content mechanism (`_content()` in
`@marko/runtime-tags/html`) needs a resume accessor to know, at hydration
time, whether OPTIONAL body content was actually passed -- this is
intrinsic to the current compiler/runtime; there is no `output`/render
option that suppresses it for `output: "html"` (checked
`@marko/compiler`'s `config.d.ts`: no resumable/hydrate flag applies).
Confirmed NOT triggered by:
- a REQUIRED `content: Marko.Body` (`composed.marko`'s page-layout, or any
  `@head` attr tag) -- no marker at all.
- a plain custom-tag call with only typed scalar/struct props and no body
  content (`vendor-tag.marko`, `nested-input.marko`, ...) -- no marker.

So the trigger is specifically: **optional** `Marko.Body` /
`Marko.AttrTag<...>` content that the caller populates.

**Status:** expected divergence for the wave-1 (no resumability) subset;
this is exactly the shape of gap the resumability wave (FR12) exists to
close -- `_content`/`_resume_branch` become real translators there instead
of `RESUME_ONLY` drops.

**Test disposition:** NOT skipped -- `helpers.mjs`'s
`renderWithJsOracle(..., { stripResumeBootstrap: true })` strips the exact
documented `RESUME_BOOTSTRAP_TAIL` pattern from the JS oracle's output
before comparing, so everything else in the fixture (attribute merging,
body rendering, spread ordering aside from #1) still gets a real
byte-comparison. TODO for the resumability wave: once `_content`/
`_el_resume`/`_resume_branch` are real translators, delete
`stripResumeBootstrap` and its fixture annotation, and assert the FULL
byte match including the resume tail (Go will need to start emitting an
equivalent, at which point this becomes a real golden case instead of a
stripped one).
