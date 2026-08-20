# runtime

The Go rendering target for marko-go: `generate`d `.marko.go` files call into
this package, not the other way around. Nobody hand-writes against most of
it — it's the transpiler's ABI, not an application API.

```go
w := runtime.New()
w.SetGlobals(ui.Globals{Path: r.URL.Path})
pages.Landing(w, pages.LandingInput{})
io.WriteString(rw, w.String())
```

(`marko.Handler`/`marko.HandlerFunc` in the `marko` package do this for you;
you would only call these directly outside an `http.Handler`.)

## What's in here

- **`writer.go`** — `Writer`, the buffered HTML sink every generated render
  function writes into. Holds request-scoped `$global` values (`SetGlobals`)
  and owns the resume channel.
- **`escape.go`, `attrs.go`** — byte-exact ports of Marko's text-content and
  attribute-value escapers (`Escape`, `Attr`, `Attrs`, `AttrClass`,
  `AttrStyle`, the `A` entry type). Attribute quoting, omission rules, and
  event-attribute detection all mirror `@marko/runtime-tags`'s HTML writer.
- **`jsvalue.go`** — JS-semantics helpers generated code needs because Go
  doesn't have them: `Truthy` (JS `if (val)`), `And`/`OrValue` (JS `&&`/`||`
  in value position, which return an operand, not a bool), `Or` (Marko's `??`
  target, though not exact-nullish since Go has no untyped "unset"), `String`
  and `Absent` (Go zero-value <-> JS `undefined` bridging for optional Input
  fields).
- **`jsnum.go`** — `formatJSNumber`, matching `ToString(x, 10)` byte-for-byte
  (exponent thresholds, `-0`, `NaN`/`Infinity` spelling) for resume payloads.
- **`for.go`** — `ForOf`/`ForOfIndexed` (typed loops) and their `*Any`
  reflection fallbacks, the target for `<for|item| of=items>`.
- **`body.go`** — `Body`, the callback type for a tag's `content` input.
- **`resume.go`, `resumestate.go`, `serialize.go`** — the resumability wave:
  scope-state tracking (`ScopeState`, `ScopeRef`), the resume-payload
  serializer, and `Writer` methods (`AllocScopeID`, `AddScope`, `Marker`,
  `FlushResume`, `SetResumeIDs`, `ClientBundle`) that flush a byte-exact
  Marko 6 resume script.
- **`version.go`** — the `GeneratedByMarkoGo_vX_Y` sentinel constants. Every
  generated file references one; a mismatch between an installed `runtime`
  and the `marko-go` CLI that produced the file fails the build loudly
  instead of misbehaving at runtime. See CONTRIBUTING.md for the release
  procedure.

## API stability (read this before using anything directly)

Most exported identifiers here — `A`, `Attrs`, `AttrClass`, `Escape`,
`Truthy`, `And`, `OrValue`, `ForOf`/`ForOfIndexed`, `ScopeState`, the resume
serializer, the version sentinels, and friends — are **not meant for
hand-written use**. They exist to be targets for generated code, and their
signatures/behavior can change between minor versions of marko-go as the
codegen's needs evolve.

They can't be Go `internal/`, though: generated `.marko.go` files live in
*your* package, so this package must export whatever generated code calls.
Known pre-1.0 API-stability caveat — treat anything not documented in the
`marko` package as implementation detail that happens to be public.
