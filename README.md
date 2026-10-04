# docker-context-scout

[![npm version](https://img.shields.io/npm/v/@barissozudogru/docker-context-scout)](https://www.npmjs.com/package/@barissozudogru/docker-context-scout)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue)](./LICENSE)

[npm](https://www.npmjs.com/package/@barissozudogru/docker-context-scout) · [Source](https://github.com/barissozudogru/docker-context-scout) · [Issues](https://github.com/barissozudogru/docker-context-scout/issues)

Inspect local build context files and review suggested `.dockerignore` rules.

Run without installing:

```bash
npx @barissozudogru/docker-context-scout
```

A local build context makes files available to Docker's builder. Dependencies,
Git metadata, build artifacts, and credential files can be unnecessary inputs.
A suitable `.dockerignore` reduces those inputs and helps prevent accidental
inclusion. [Docker loads context files as needed](https://docs.docker.com/build/concepts/context/);
this tool's filesystem totals are not measurements of bytes transferred or final
image size.

`docker-context-scout` walks the selected directory, measures entries, checks
`.dockerignore`, and suggests rules. Review the suggestions against your Dockerfile
before using `--fix`: some builds intentionally copy prebuilt artifacts.

## Usage

```
docker-context-scout [path] [options]

Arguments:
  path                    Directory to analyze (default: current directory)

Options:
  --fix                   Append suggested rules to .dockerignore
  --json                  Output results as JSON (for CI pipelines)
  --threshold <MB>        Only show entries above this size in MB
  --version, -v           Show version number
  --help, -h              Show help
```

### Analyze the current directory

```bash
docker-context-scout
```

### Analyze a specific project

```bash
docker-context-scout ./my-app
```

### Apply suggestions automatically

```bash
docker-context-scout --fix
```

### Filter noise - only show entries above 10 MB

```bash
docker-context-scout --threshold 10
```

---

## Options

| Option | Description | Default |
|---|---|---|
| `path` | Directory to analyze | Current working directory |
| `--fix` | Append suggested rules to `.dockerignore` (creates it if absent) | Off |
| `--json` | Emit machine-readable JSON to stdout | Off |
| `--threshold <MB>` | Hide entries smaller than this threshold | Show all |
| `--version`, `-v` | Print version and exit | - |
| `--help`, `-h` | Print usage and exit | - |

---

## Reading the report

The report shows directory size, file count, the largest entries, suggested ignore
rules, and estimated savings. `--json` exposes the same analysis for scripts.
These are local filesystem estimates. Confirm actual build context transfer in
Docker's build output after reviewing changes to `.dockerignore`.

## What It Detects

| Pattern | Reason |
|---|---|
| `.git` | Git metadata is never needed in Docker images |
| `node_modules` | Dependencies are reinstalled during build via npm/yarn/pnpm |
| `__pycache__` / `*.pyc` | Python bytecode cache is regenerated at runtime |
| `.env*` | Environment files must never be baked into images |
| `*.md` | Documentation files are not needed at runtime |
| `test` / `tests` / `__tests__` | Test files and directories are not needed in production images |
| `.vscode` / `.idea` | Editor configuration has no purpose inside containers |
| `dist` / `build` | Build artifacts should be produced inside the Docker build |
| `coverage` | Test coverage reports are not needed in production images |
| `.next` / `.nuxt` | Framework build caches should be regenerated inside the Docker build |
| `*.log` | Log files are generated at runtime and must not be baked in |
| `.DS_Store` / `Thumbs.db` | OS metadata files are irrelevant in Linux containers |
| `.terraform` / `*.tfstate*` | Terraform state may contain secrets and is not needed at runtime |

---

## CI Integration

Use `--json` to gate builds on context size in any CI pipeline.

### GitHub Actions - fail if context exceeds 50 MB

```yaml
- name: Check Docker build context
  run: |
    npx @barissozudogru/docker-context-scout --json > context.json
    SIZE=$(node -e "const r=require('./context.json'); process.exit(r.totalSizeMB > 50 ? 1 : 0)")
  shell: bash
```

### Extract reduction percentage

```bash
docker-context-scout --json | jq '.reductionPercentage'
```

### JSON fields

`--json` returns the scanned path, total size and file count, sized entries,
suggested rules, estimated optimised size, and potential reduction. Sizes and
savings depend on the scanned directory and its existing `.dockerignore`.

## Exit Codes

| Code | Meaning |
|---|---|
| `0` | Analysis completed successfully |
| `1` | Error - invalid path, unreadable directory, or bad argument |

---

## Development and support

Report problems through [GitHub issues](https://github.com/barissozudogru/docker-context-scout/issues). See [CONTRIBUTING.md](./CONTRIBUTING.md) for the contribution workflow.

To build and test a source checkout with Node.js 22:

```bash
npm ci
npm test
npm run build
```

The default branch can contain changes that have not yet been published to npm.

## License

[MIT](./LICENSE) - Baris Sozudogru
