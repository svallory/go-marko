# marko

The package an app author imports directly. Small, and meant to stay that
way — it's the stable adapter between `net/http` and marko-go's generated
render functions, in the spirit of templ's `http.Handler` helpers.

```go
mux := http.NewServeMux()
marko.MountClientAssets(mux, "ui/.marko-go/client")
mux.Handle("GET /", marko.Handler(pages.Landing, marko.WithGlobals(pageGlobals)))
mux.Handle("GET /user/{id}", marko.HandlerFunc(
    func(w http.ResponseWriter, r *http.Request) pages.UserInput {
        return pages.UserInput{ID: r.PathValue("id")}
    },
    pages.User,
))
```

## What's in here

- **`handler.go`** — `Handler[T]` wraps a render function that takes the
  zero value of its input; `HandlerFunc[T]` pairs it with a `build` function
  that constructs the input from the incoming request (path values, query
  params, headers). Both render into a fresh `runtime.Writer`, set
  `Content-Type: text/html; charset=utf-8`, and write the result
  synchronously — no streaming.
- **`options.go`** — `Option` and `WithGlobals`. `WithGlobals` supplies the
  request-scoped `$global` values every template reads (`ui.Globals`,
  generated from the project's `global.d.ts`); it's called once per request
  before rendering. Handlers built without it render with zero-value
  globals.
- **`client.go`** — `MountClientAssets`/`MountClientAssetsAt` serve the
  per-page browser bundles `marko-go generate` writes for reactive pages
  (`.marko-go/client/<page>.js`), with the right `Content-Type` and a
  `no-store` cache policy (a stale cached bundle registers setup closures
  under registry ids the current page's payload no longer uses — the
  hardest failure mode here to debug). `ClientAssets` is the lower-level
  `http.Handler` if you need custom mounting.

## Contrast with `runtime/`

`runtime/` is generated-code plumbing: everything a `.marko.go` file's body
calls into, and it will keep growing and shifting as the transpiler grows
(new intrinsics, wire-format changes, more of Marko's tag surface). This
package is the opposite: a handful of functions an application calls once
per route, with an API surface intended to stay small and stable across
versions. If you find yourself importing `runtime` directly in application
code (outside a generated file), that is almost always a sign you want
something added here instead.
