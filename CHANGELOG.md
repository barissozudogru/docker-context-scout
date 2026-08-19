# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.3.0] - 2026-01-15

### Fixed

- Symlink loop detection via inode tracking prevents infinite traversal.
- `.dockerignore` negation patterns (`!path`) are now respected correctly.
- Removed redundant `stat` calls during directory walk to cut I/O roughly in half on large trees.
- `--version` / `-v` flag now prints only the version string, suitable for scripting.

### Changed

- Source maps removed from published package to reduce install size.
- README updated with accurate CLI reference.

---

## [0.2.0] - 2025-12-10

### Added

- `--threshold <MB>` option to suppress entries below a given size.
- TTY-aware color output  -  ANSI escape codes are suppressed when stdout is not a terminal (pipes, CI logs).
- `dockerfileFound` field in JSON output.
- Detection of `.terraform` and `*.tfstate*` patterns.

### Changed

- Suggestions are now sorted by estimated savings (largest first).
- Top offenders list capped at 20 entries instead of 10.

---

## [0.1.0] - 2025-11-20

### Added

- Initial release.
- Recursive directory walker with `.dockerignore` glob evaluation.
- Detection of 15 common excludable patterns (`.git`, `node_modules`, `__pycache__`, `.env*`, `*.md`, test directories, editor configs, `dist`, `build`, `coverage`, `.next`, `.nuxt`, `*.log`, OS metadata files).
- `--fix` flag to write or append rules to `.dockerignore`.
- `--json` flag for machine-readable output.
- Zero runtime dependencies  -  ships as a single compiled JS file.
