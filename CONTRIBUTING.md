# Contributing to Go, Marko!

Thanks for your interest in contributing. This repo is a
[moon](https://moonrepo.dev)-managed monorepo containing:

- `runtime/`, `marko/` — the Go module (`github.com/svallory/go-marko`)
- `packages/marko-go/` — the npm package `marko-go` (the `.marko` → Go compiler/CLI), managed with [bun](https://bun.sh)
- `examples/` — generated example apps kept in sync with `packages/marko-go/` in CI

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

### Codegen package (packages/marko-go/)

```sh
cd packages/marko-go
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

## Releasing

`marko-go` (packages/marko-go/) and the Go module `github.com/svallory/go-marko`
(runtime/, marko/) are versioned in lockstep: one version, sourced from
`packages/marko-go/package.json`'s `"version"`. A single git tag `vX.Y.Z` releases
both — Go modules resolve versions straight from repo tags, so the same tag
that npm-publishes `marko-go` also *is* the Go module's release.

Every file `marko-go` generates embeds a reference to a runtime constant
named after its major.minor version (`runtime.GeneratedByMarkoGo_v0_1`, see
`runtime/version.go`). If a project's installed `runtime` package and
`marko-go` CLI ever drift on major/minor, `go build` fails immediately with
`undefined: runtime.GeneratedByMarkoGo_vX_Y` instead of a confusing
downstream error. A patch bump never touches this marker.

To cut a release:

1. Bump `"version"` in `packages/marko-go/package.json`.
   - Bumping the **major or minor** also requires adding the matching
     `GeneratedByMarkoGo_vX_Y` constant to `runtime/version.go` (keep the old
     one too, until no supported release still needs it — see that file's
     doc comment).
   - A **patch** bump needs no runtime change.
2. Regenerate generated output and commit any diff:
   ```sh
   cd packages/marko-go && UPDATE_GOLDENS=1 bun test test/golden/golden.test.mjs
   moon run marko-go:generate-examples   # or: moon run :check
   ```
3. Run the lockstep check locally (also enforced in CI):
   ```sh
   bun scripts/release-check.mjs
   ```
   This asserts `packages/marko-go/package.json`'s version, the marker codegen emits,
   and the constant `runtime/version.go` exports all agree.
4. Commit, then tag and push:
   ```sh
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```
5. Publish `marko-go` to npm manually (no automated publish yet):
   ```sh
   cd packages/marko-go && npm publish
   ```
   The Go module needs no separate publish step — `go get
   github.com/svallory/go-marko@vX.Y.Z` resolves directly from the pushed tag.

## Code style

- Go code: standard `gofmt`/`go vet` conventions.
- Codegen (`packages/marko-go/`): plain `.mjs`, no build step — keep it that
  way (see `packages/marko-go/package.json` — this package intentionally
  ships un-transpiled JavaScript).

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
