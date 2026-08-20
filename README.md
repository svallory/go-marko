# Go, Marko!

Render [Marko](https://markojs.com) templates — TS-typed, custom tags, client
reactivity via resumability — from Go.

`marko-go` compiles `.marko` templates into type-safe Go render functions, so
you write your UI in Marko and serve it from a Go backend with no JS runtime
required at request time.

## Install

- CLI / codegen (npm): `npm install -D marko-go` (or `bun add -d marko-go`)
- Go module: `go get github.com/svallory/go-marko`

> **Naming**: the CLI and npm package are `marko-go`; the Go module is
> `go-marko`.

## Usage

```sh
marko-go generate ./ui
```

This compiles every `.marko` file under `./ui` into a sibling `*.marko.go`
file exposing a typed render function you call from your Go handlers.

## Repo layout

- `runtime/`, `marko/` — the Go module (`github.com/svallory/go-marko`)
- `codegen/` — the npm package (`marko-go`), the compiler/CLI
- `examples/` — generated example apps, kept in sync with codegen in CI

## Docs

- Documentation: <https://go-marko.saulo.tech>
- Quickstart: <https://github.com/svallory/go-marko-quickstart>

## License

MIT
