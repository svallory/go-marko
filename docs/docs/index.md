# Go, Marko!

Write UI in [Marko](https://markojs.com) — TS-typed templates, custom tags,
and real client-side reactivity via Marko's resumability — and serve it from
a Go server with zero Node in production.

`marko-go` compiles `.marko` templates to plain Go functions at build time,
the same way `templ` compiles `.templ` files. No template interpreter, no
Node process at runtime. Pages that use Marko's `<let>`/`onClick`
reactivity get a small per-page client bundle; pages that don't ship no
JavaScript at all.

## 30 seconds

`ui/pages/hello.marko`:

```marko
export interface Input {
  name: string;
}

<div class="greeting">
  Hello, ${input.name}!
</div>
```

`marko-go generate ./ui` emits `ui/pages/hello.marko.go`:

```go
package pages

type HelloInput struct {
	Name string
}

func Hello(w *runtime.Writer, input HelloInput) {
	// renders the template
}
```

Wire it up with the `marko` HTTP helper package:

```go
mux := http.NewServeMux()
mux.Handle("GET /hello", marko.HandlerFunc(
	func(w http.ResponseWriter, r *http.Request) pages.HelloInput {
		return pages.HelloInput{Name: r.URL.Query().Get("name")}
	},
	pages.Hello,
))
```

`GET /hello?name=World` renders:

```html
<div class="greeting">
  Hello, World!
</div>
```

## Why

- **Templates compile to Go.** `marko-go generate` runs at dev/build time;
  the running server never parses a template.
- **Typed end to end.** `export interface Input { ... }` in the template
  becomes a Go `Input` struct — calling a template is a normal typed
  function call.
- **Custom tags, zero imports.** `<ui-button>`, `<page-layout>`, `<icon-*>`
  resolve by filesystem convention, exactly like Marko in Node.
- **Real client reactivity.** `<let>` state and `onClick` handlers hydrate
  in the browser via Marko's resumability — not a full SPA runtime, just the
  bits a page actually uses.
- **templ-parity dev loop.** `marko-go generate --watch --proxy=... --cmd=...`
  — regenerate, restart, live-reload, one command.
- **No bundle tax for static pages.** A page with no `<let>`/handlers ships
  no client JavaScript.

## Where to go next

- [Install](./install.md) — prerequisites and setup.
- [Getting started](./getting-started.md) — clone the quickstart, run it,
  understand the project layout.
- [Templates](./templates.md) — the supported Marko template surface.
- [Reactivity](./reactivity.md) — `<let>` and client-side hydration.
- [HTTP](./http.md) — the `marko` package: `Handler`, `HandlerFunc`,
  `WithGlobals`, `MountClientAssets`.
- [CLI](./cli.md) — `marko-go generate`, watch mode, flags.
