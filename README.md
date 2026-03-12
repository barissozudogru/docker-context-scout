# docker-context-scout

Analyze your Docker build context size and get actionable `.dockerignore` suggestions.

## Installation

```bash
npm install -g @barissozudogru/docker-context-scout
```

Or run without installing:

```bash
npx @barissozudogru/docker-context-scout
```

## Usage

```
docker-context-scout [path] [options]

Arguments:
  path          Directory to analyze (default: current directory)

Options:
  --fix               Append suggested rules to .dockerignore
  --json              Output results as JSON (for CI pipelines)
  --threshold <MB>    Only show files/dirs above this size in MB
  --version, -v       Show version number
  --help, -h          Show this help message
```

### Analyze current directory

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

### CI/CD integration

```bash
docker-context-scout --json | jq '.reductionPercentage'
```

## What it detects

- `.git` - Git metadata
- `node_modules` - JavaScript dependencies
- `__pycache__` / `.pyc` - Python bytecode cache
- `.env*` - Environment files (security risk if baked in)
- `*.md` - Documentation files
- `test` / `tests` / `__tests__` - Test directories
- `.vscode` / `.idea` - Editor configuration
- `dist` / `build` - Build output directories
- `coverage` - Test coverage reports
- `.next` / `.nuxt` - Framework build caches
- `*.log` - Log files
- `.DS_Store` / `Thumbs.db` - OS metadata
- `.terraform` / `*.tfstate*` - Terraform state files

## Output example

```
  Docker Context Scout
------------------------------------------------------------
  Path:        /Users/you/my-project
  Total size:  245.30 MB (3842 files)
  .dockerignore: not found

  Top 10 items by size:
------------------------------------------------------------
  [dir ]  node_modules                             235.10 MB
  [dir ]  .git                                       8.20 MB
  [dir ]  coverage                                   1.80 MB

  Suggested .dockerignore rules:
------------------------------------------------------------
  node_modules               saves ~235.10 MB  Dependencies are reinstalled during build
  .git                       saves ~  8.20 MB  Git metadata is never needed in Docker images
  coverage                   saves ~  1.80 MB  Test coverage reports are not needed

------------------------------------------------------------
  Estimated context after optimization: 0.20 MB
  Potential reduction: 99.9% (245.10 MB)
```

## License

MIT
