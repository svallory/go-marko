# Contributing to Go, Marko!

Thanks for your interest in contributing. This repo is a
[moon](https://moonrepo.dev)-managed monorepo containing:

- `runtime/`, `marko/` — the Go module (`github.com/svallory/go-marko`)
- `codegen/` — the npm package `marko-go` (the `.marko` → Go compiler/CLI), managed with [bun](https://bun.sh)
- `examples/` — generated example apps kept in sync with `codegen/` in CI

## Development setup

Prerequisites: [proto](https://moonrepo.dev/proto) (manages the pinned `bun`
and `go` versions in `.prototools`), or matching versions installed manually.

```sh
git clone https://github.com/svallory/go-marko.git
cd go-marko
proto use               # installs bun + go per .prototools
```

### Go module (runtime/, marko/)

```sh
go test -buildvcs=false ./...
go vet ./...
go build -buildvcs=false ./...
```

### Codegen package (codegen/)

```sh
cd codegen
bun install
bun test
```

### Running everything moon knows about

```sh
moon run :check
```

This runs `go vet`, `go test`, `go build`, and the codegen test suite, and is
the same aggregate check CI runs.

### Examples

`examples/` holds generated output committed to the repo so drift is visible
in diffs. If you change codegen output, regenerate the examples and include
the diff in your PR — CI fails the build if `examples/` doesn't match what
codegen currently produces (`git diff --exit-code examples/`).

## Code style

- Go code: standard `gofmt`/`go vet` conventions.
- Codegen (`codegen/`): plain `.mjs`, no build step — keep it that way (see
  `codegen/package.json` — this package intentionally ships un-transpiled
  JavaScript).

## Commit messages & PRs

- Use [Conventional Commits](https://www.conventionalcommits.org/) for commit
  messages (`feat:`, `fix:`, `chore:`, `docs:`, etc.).
- Keep PRs focused. Link related issues (`Fixes #123`).
- Make sure `moon run :check` passes before opening a PR.
- Fill in the PR template — it's short.

## Reporting bugs / requesting features

Use the issue templates when opening a
[new issue](https://github.com/svallory/go-marko/issues/new/choose).

## Security issues

Do not open a public issue for security vulnerabilities — see
[SECURITY.md](./SECURITY.md).

## Questions

Open a [GitHub Discussion](https://github.com/svallory/go-marko/discussions)
or an issue if Discussions aren't enabled yet.
