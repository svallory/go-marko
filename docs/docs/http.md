# HTTP

`github.com/svallory/go-marko/marko` adapts generated render functions to
`net/http`. It mirrors `templ`'s `http.Handler` helpers: wrap a generated
render function, get back a ready-to-mount `http.Handler`.

## Handler

For a page whose `Input` needs no per-request data (its `Input` is empty or
you're fine rendering the zero value):

```go
mux.Handle("GET /", marko.Handler(pages.Landing))
```

`Handler` renders into a fresh `runtime.Writer`, sets
`Content-Type: text/html; charset=utf-8`, and writes the result. Rendering
is synchronous and unbuffered — no streaming.

## HandlerFunc

For a page whose `Input` is built from the request (path values, query
params, headers, form data, session state):

```go
mux.Handle("GET /counter", marko.HandlerFunc(counterInput, pages.Counter))

func counterInput(w http.ResponseWriter, r *http.Request) pages.CounterInput {
	id := sessionID(w, r)
	return pages.CounterInput{
		Global: float64(globalCount),
		User:   float64(userCounts[id]),
		Events: counterFeed,
	}
}
```

The build function receives `http.ResponseWriter` too, so it **may** set
response headers or cookies (e.g. minting a session cookie on first visit)
before the page renders — but it **must not** write the response body or
call `WriteHeader`. `HandlerFunc` writes the rendered HTML itself after
`build` returns.

## WithGlobals

Supplies `$global` values for every request the handler serves:

```go
mux.Handle("GET /", marko.Handler(pages.Landing,
	marko.WithGlobals(func(r *http.Request) ui.Globals {
		return ui.Globals{Path: r.URL.Path}
	}),
))
```

`build` runs once per request, before rendering. `ui.Globals` is normally
the struct `marko-go generate` derives from the `Marko.Global` interface in
`global.d.ts` — the type here must match the generated one exactly, or
templates silently see zero-value globals instead of panicking. Handlers
built without `WithGlobals` (and direct `pages.Foo(w, input)` calls) also
just get zero-value globals.

`WithGlobals` works the same way on both `Handler` and `HandlerFunc`.

## MountClientAssets

Serves the browser bundles `marko-go generate` writes for reactive pages —
see [Reactivity](./reactivity.md):

```go
marko.MountClientAssets(mux, "ui/.marko-go/client")
```

Mounts at the default URL prefix (`/.marko-go/client/`) with
`http.StripPrefix` already wired up. If you passed a custom `--client-url`
to `marko-go generate`, mount at the matching prefix instead:

```go
marko.MountClientAssetsAt(mux, "/assets/js/", "ui/.marko-go/client")
```

## POST / redirect pattern

Non-reactive pages that mutate state do it the plain HTML way — a form POST
handler, then a redirect back to a GET:

```go
mux.HandleFunc("POST /counter", func(w http.ResponseWriter, r *http.Request) {
	id := sessionID(w, r)
	r.ParseForm()

	switch r.Form.Get("target") {
	case "global":
		globalCount++
	case "user":
		userCounts[id]++
	}

	http.Redirect(w, r, "/counter", http.StatusSeeOther)
})
```

The GET handler for the same path (`marko.HandlerFunc(counterInput,
pages.Counter)`) re-reads the now-updated state on the next render — no
client JavaScript involved.
