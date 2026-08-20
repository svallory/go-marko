# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Initial codegen and runtime: compile `.marko` templates to type-safe Go
  render functions.
- Custom tag composition.
- TS-typed input structs generated per template.
- Watch mode for the codegen CLI (`--watch`/`--proxy` dev loop).
- Support for installed tag packages.
- `$global` support.
- Attribute tags.
- Resumability, wave 1 (client reactivity groundwork).

[Unreleased]: https://github.com/svallory/go-marko/compare/main...HEAD
