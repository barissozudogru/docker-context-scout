# docker-context-scout

Find out what Docker is sending as build context and cut it down to size.

Run without installing:

```bash
npx @barissozudogru/docker-context-scout
```

Every time you run `docker build`, Docker compresses and streams your entire project directory to the build daemon before a single instruction executes. On a typical Node.js or Python project it is not uncommon to send 400 MB or more of `node_modules`, `.git`, and build artifacts that your final image doesn't need. This slows down builds because Docker re-uploads the full context even for layer-cache hits, risks baking secrets like `.env` files or Terraform state into image layers, and creates unnecessarily large images.

docker-context-scout walks your project, measures each entry, cross-references your existing `.dockerignore`, and tells you exactly what is bloating your build context and how to fix it. A single `--fix` flag writes the `.dockerignore` rules for you.

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

### Filter noise  -  only show entries above 10 MB

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
| `--version`, `-v` | Print version and exit |  -  |
| `--help`, `-h` | Print usage and exit |  -  |

---

## Example Output

```
  Docker Context Scout
------------------------------------------------------------
  Path:        /Users/you/my-app
  Total size:  487.20 MB (6 241 files)
  .dockerignore: not found

  Top items by size:
------------------------------------------------------------
  [dir ]  node_modules                                342.00 MB
  [dir ]  .git                                         89.00 MB
  [dir ]  dist                                         38.10 MB
  [dir ]  coverage                                     14.80 MB
  [file]  db/seed-data.sql                              2.90 MB
  [dir ]  .next                                         0.40 MB

  Suggested .dockerignore rules:
------------------------------------------------------------
  node_modules               saves ~   342.00 MB  Dependencies are reinstalled during build
  .git                       saves ~    89.00 MB  Git metadata is never needed in Docker images
  dist                       saves ~    38.10 MB  Build artifacts should be produced inside the Docker build
  coverage                   saves ~    14.80 MB  Test coverage reports are not needed in production images
  .next                      saves ~     0.40 MB  Next.js build cache should be regenerated inside the Docker build

------------------------------------------------------------
  Estimated context after optimization: 12.00 MB
  Potential reduction: 97.5% (475.20 MB)
```

After running `--fix`, a `.dockerignore` is created with all suggested rules.

---

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

### GitHub Actions  -  fail if context exceeds 50 MB

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

### Full JSON schema

```json
{
  "analyzedPath": "/absolute/path",
  "totalSizeBytes": 510980096,
  "totalSizeMB": 487.20,
  "fileCount": 6241,
  "dockerfileFound": true,
  "existingDockerignoreRules": [],
  "topOffenders": [
    { "path": "node_modules", "size": 358612992, "isDirectory": true }
  ],
  "suggestedRules": [
    {
      "pattern": "node_modules",
      "reason": "Dependencies are reinstalled during build via npm/yarn/pnpm install",
      "estimatedSavingsBytes": 358612992
    }
  ],
  "estimatedReducedSizeBytes": 12582912,
  "estimatedReducedSizeMB": 12.00,
  "reductionPercentage": 97.5
}
```

---

## Exit Codes

| Code | Meaning |
|---|---|
| `0` | Analysis completed successfully |
| `1` | Error  -  invalid path, unreadable directory, or bad argument |

---

## License

[MIT](./LICENSE)  -  Baris Sozudogru
