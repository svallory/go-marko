# Getting started

## Run the quickstart

```sh
git clone https://github.com/svallory/go-marko-quickstart.git myapp
rm -rf myapp/.git
cd myapp
cp .env.example .env
bun install
task dev
```

`bun install` doesn't install a JS framework — the quickstart uses it only
to get the Tailwind CSS CLI onto `PATH` for `task tailwind`. `task dev` runs
the Tailwind watcher and the template watcher (`marko-go generate --watch`)
in parallel.

Open **`http://localhost:7331`**.

### Why two ports

`task dev` starts two things: your app, listening on `:8090`, and a reload
proxy in front of it, listening on `:7331`. The proxy is what you open in
the browser — it forwards every request to `:8090` and, for `text/html`
responses, injects a small live-reload script before `</body>`. Every time
you save a `.marko` file, `marko-go` regenerates the Go, restarts your app
process, waits for `:8090` to come back up, then tells the browser to
reload. Hitting `:8090` directly still renders the app fine, it just won't
auto-reload.

If you want your own module path:

```sh
go mod edit -module your/module/path
```

## Anatomy

```
ui/
  pages/     # one file per route
  tags/      # reusable custom tags, auto-discovered
  global.d.ts
```

### `ui/pages/`

Each `.marko` file here is a page. `marko-go generate` emits a sibling
`<name>.marko.go` (package `pages`) with a render function and an `Input`
struct derived from the template's `export interface Input`. These
generated files are **gitignored** — they're build output, regenerated on
every `marko-go generate` run, just like `.templ.go` files in a `templ`
project.

### `ui/tags/`

Reusable tags. Marko discovers tags from this directory by filename — no
imports needed. `ui/tags/icons/icon-book.marko` becomes usable as
`<icon-book>` anywhere in the project; `ui/tags/elements/ui-button.marko`
becomes `<ui-button>`. Each subdirectory is just organizational grouping
(`icons/`, `elements/`, `layouts/`, `modules/` in the quickstart) — it does
not become part of the tag name.

**Do not name a grouping folder `components`.** A directory literally named
`components` inside a `tags/` tree collides with Marko's legacy
single-file-component discovery convention from earlier Marko versions.
Pick any other name (`elements/`, `widgets/`, `ui/`, ...).

### Generated `<name>.marko.go` files

Every `.marko` file compiles to a Go file next to it: same base name, `.go`
appended (`counter.marko` → `counter.marko.go`), same directory, same
package as its siblings. They are:

- Regenerated in full on every `marko-go generate` (or `--watch` cycle) —
  don't hand-edit them.
- Gitignored (`*.marko.go`) — they're derived output, not source.
- Normal Go: exported render functions and `Input` structs you import and
  call like any other Go code.

### Input structs from `export interface Input`

Every template starts with a TypeScript interface:

```marko
export interface Input {
  global: number;
  user: number;
  events: { label: string; count: number }[];
}
```

`marko-go generate` turns this into a Go struct with PascalCase fields —
`CounterInput{ Global float64; User float64; Events []CounterInputEvents }`
in the example above. Nested object types become nested generated structs
(`CounterInputEvents`). See [Templates](./templates.md) for the full type
mapping, including the TS `number` → Go `float64` caveat.

## Next

- [Templates](./templates.md) for the supported template syntax.
- [Reactivity](./reactivity.md) for the `<let>`/`onClick` counter page.
- [HTTP](./http.md) for wiring pages into `net/http`.
