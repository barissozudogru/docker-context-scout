import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FileEntry, AnalysisResult, PatternSuggestion } from './types.js';

/**
 * Rules used both to estimate savings and to generate .dockerignore lines.
 *
 * The two must agree. Docker matches a bare pattern against the context root
 * only: `*.md` skips root markdown but keeps `docs/guide.md`, and `__pycache__`
 * skips a root cache directory but keeps every nested one. Matching anywhere in
 * the tree requires the `**\/` prefix.
 *
 * So a rule whose matchers are unanchored (they can hit any path segment) must
 * emit a `**\/` pattern, and a rule whose matchers are anchored with `^` must
 * not. `assertPatternsMatchMatchers` in the tests enforces exactly that, because
 * hand-keeping these two fields in sync is what drifted in the first place.
 */
const EXCLUDABLE_PATTERNS: Array<{ pattern: string; matchers: RegExp[]; reason: string }> = [
  {
    pattern: '.git',
    matchers: [/^\.git(\/|$)/],
    reason: 'Git metadata is never needed in Docker images',
  },
  {
    pattern: '**/node_modules',
    matchers: [/node_modules(\/|$)/],
    reason: 'Dependencies are reinstalled during build via npm/yarn/pnpm install',
  },
  {
    pattern: '**/__pycache__',
    matchers: [/__pycache__(\/|$)/],
    reason: 'Python bytecode cache is regenerated at runtime',
  },
  {
    pattern: '**/*.pyc',
    matchers: [/\.pyc$/],
    reason: 'Compiled Python bytecode is regenerated at runtime',
  },
  {
    pattern: '**/.venv',
    matchers: [/(^|\/)\.venv(\/|$)/],
    reason: 'Virtualenvs are platform-specific and reinstalled from requirements during build',
  },
  {
    pattern: '**/venv',
    matchers: [/(^|\/)venv(\/|$)/],
    reason: 'Virtualenvs are platform-specific and reinstalled from requirements during build',
  },
  {
    pattern: '**/.tox',
    matchers: [/(^|\/)\.tox(\/|$)/],
    reason: 'tox environments are rebuilt on demand',
  },
  {
    pattern: '**/.mypy_cache',
    matchers: [/(^|\/)\.mypy_cache(\/|$)/],
    reason: 'Type-checker cache is regenerated on demand',
  },
  {
    pattern: '**/.pytest_cache',
    matchers: [/(^|\/)\.pytest_cache(\/|$)/],
    reason: 'Test-runner cache is regenerated on demand',
  },
  {
    pattern: '**/.ruff_cache',
    matchers: [/(^|\/)\.ruff_cache(\/|$)/],
    reason: 'Linter cache is regenerated on demand',
  },
  {
    pattern: '**/*.egg-info',
    matchers: [/\.egg-info(\/|$)/],
    reason: 'Python packaging metadata is regenerated during build',
  },
  {
    pattern: '**/.env*',
    matchers: [/(^|\/)\.env(\.|$)/],
    reason: 'Environment files must never be baked into images',
  },
  {
    pattern: '**/*.md',
    matchers: [/\.mdx?$/i],
    reason: 'Documentation files are not needed at runtime',
  },
  {
    pattern: 'tests',
    matchers: [/^tests?(\/|$)/],
    reason: 'Test directories are not needed in production images',
  },
  {
    pattern: '**/__tests__',
    matchers: [/__tests__(\/|$)/],
    reason: 'Test directories are not needed in production images',
  },
  {
    pattern: '**/*.test.*',
    matchers: [/\.test\.[jt]sx?$/],
    reason: 'Test files are not needed in production images',
  },
  {
    pattern: '**/*.spec.*',
    matchers: [/\.spec\.[jt]sx?$/],
    reason: 'Spec files are not needed in production images',
  },
  {
    pattern: '.vscode',
    matchers: [/^\.vscode(\/|$)/],
    reason: 'Editor configuration has no purpose inside containers',
  },
  {
    pattern: '.idea',
    matchers: [/^\.idea(\/|$)/],
    reason: 'JetBrains IDE configuration has no purpose inside containers',
  },
  {
    pattern: 'dist',
    matchers: [/^dist(\/|$)/],
    reason: 'Build output should be produced inside the Docker build, not copied in',
  },
  {
    pattern: 'build',
    matchers: [/^build(\/|$)/],
    reason: 'Build artifacts should be produced inside the Docker build',
  },
  {
    pattern: 'target',
    matchers: [/^target(\/|$)/],
    reason: 'Rust and Maven build output should be produced inside the Docker build',
  },
  {
    pattern: 'vendor',
    matchers: [/^vendor(\/|$)/],
    reason: 'Vendored dependencies are restored during build',
  },
  {
    pattern: '.gradle',
    matchers: [/^\.gradle(\/|$)/],
    reason: 'Gradle cache is regenerated inside the Docker build',
  },
  {
    pattern: 'coverage',
    matchers: [/^coverage(\/|$)/],
    reason: 'Test coverage reports are not needed in production images',
  },
  {
    pattern: '.next',
    matchers: [/^\.next(\/|$)/],
    reason: 'Next.js build cache should be regenerated inside the Docker build',
  },
  {
    pattern: '.nuxt',
    matchers: [/^\.nuxt(\/|$)/],
    reason: 'Nuxt.js build cache should be regenerated inside the Docker build',
  },
  {
    pattern: '**/*.log',
    matchers: [/\.log$/],
    reason: 'Log files are generated at runtime and must not be baked in',
  },
  {
    pattern: '**/.DS_Store',
    matchers: [/\.DS_Store$/],
    reason: 'macOS metadata files are irrelevant in Linux containers',
  },
  {
    pattern: '**/Thumbs.db',
    matchers: [/Thumbs\.db$/],
    reason: 'Windows thumbnail cache files are irrelevant in Linux containers',
  },
  {
    pattern: '.terraform',
    matchers: [/^\.terraform(\/|$)/],
    reason: 'Terraform state and provider cache should not be copied into images',
  },
  {
    pattern: '**/*.tfstate*',
    matchers: [/\.tfstate/],
    reason: 'Terraform state files may contain secrets and are not needed at runtime',
  },
];

/** Exported for the invariant test that keeps patterns and matchers in sync. */
export const EXCLUDABLE_PATTERNS_FOR_TEST = EXCLUDABLE_PATTERNS;

function stripInlineComment(line: string): string {
  // Docker only honours '#' at column 1 as a comment; a '#' mid-line is part of
  // the pattern. For comparison we drop anything after the first inline '#',
  // so a hand-annotated rule is still recognised as covering its pattern.
  const hashIndex = line.indexOf('#');
  return hashIndex > 0 ? line.slice(0, hashIndex).trim() : line;
}

interface CompiledRule {
  original: string;
  isNegative: boolean;
  regex: RegExp;
}

function readDockerignore(dirPath: string): { rules: CompiledRule[]; all: string[] } {
  const dockerignorePath = path.join(dirPath, '.dockerignore');
  if (!fs.existsSync(dockerignorePath)) {
    return { rules: [], all: [] };
  }
  const lines = fs
    .readFileSync(dockerignorePath, 'utf-8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map(stripInlineComment)
    .filter((l) => l);

  const rules: CompiledRule[] = lines.map((l) => {
    const isNegative = l.startsWith('!');
    const pattern = isNegative ? l.slice(1) : l;
    return {
      original: l,
      isNegative,
      regex: dockerignoreGlobToRegex(pattern)
    };
  });

  return { rules, all: lines };
}

/**
 * Convert a single .dockerignore glob rule into a RegExp.
 * Docker's glob semantics:
 *   - Matching happens against the path relative to the context root. Leading
 *     and trailing slashes are disregarded, and a slash-free rule such as
 *     `node_modules` matches only the root entry, never `pkg/node_modules`.
 *   - '*' matches any sequence of non-separator characters (not '/')
 *   - '**' as a whole path segment matches any number of directories, zero included
 *   - '?' matches a single non-separator character
 */
function dockerignoreGlobToRegex(rule: string): RegExp {
  const normalized = rule.replace(/\\/g, '/').replace(/\/+$/, '');
  const stripped = normalized.startsWith('/') ? normalized.slice(1) : normalized;
  const segments = stripped.split('/').filter((s) => s !== '');

  // A trailing '**' adds nothing: the suffix appended below already allows any
  // subtree below a match, so 'logs/**' behaves like 'logs'.
  while (segments.length > 1 && segments[segments.length - 1] === '**') {
    segments.pop();
  }

  // A lone '**' matches the whole tree, which the segment loop below cannot
  // express because it only ever matches complete path segments.
  if (segments.length === 1 && segments[0] === '**') {
    return /^.*$/;
  }

  let reStr = '';
  segments.forEach((segment, index) => {
    // A segment in the middle of the rule is glued to the one before it by a
    // separator. The one exception follows a '**', which has already swallowed
    // that separator on its right. Without the separator a rule such as
    // `a/**/b` would match `ab` while never matching `a/b`.
    if (index > 0 && segments[index - 1] !== '**') {
      reStr += '/';
    }

    if (segment === '**') {
      // A whole '**' segment matches zero or more directories, so '**/foo'
      // hits both 'foo' and 'a/b/foo'.
      reStr += '(?:[^/]+/)*';
      return;
    }

    let i = 0;
    while (i < segment.length) {
      if (segment[i] === '*') {
        // '*' never crosses a '/', and neither do the double stars inside a
        // segment such as 'a**b'; only a whole '**' segment spans directories.
        reStr += '[^/]*';
        i++;
      } else if (segment[i] === '?') {
        reStr += '[^/]';
        i++;
      } else {
        // Escape regex metacharacters
        reStr += segment[i].replace(/[.+^${}()|[\]\\]/g, '\\$&');
        i++;
      }
    }
  });

  return new RegExp(`^${reStr}(/.*)?$`);
}

function matchesDockerignore(
  relPath: string,
  rules: CompiledRule[]
): boolean {
  let matched = false;

  for (const rule of rules) {
    if (rule.regex.test(relPath)) {
      matched = !rule.isNegative;
    }
  }

  return matched;
}

function walkDirectory(
  dirPath: string,
  rootPath: string,
  rules: CompiledRule[],
  entries: FileEntry[],
  visitedInodes: Set<number>
): void {
  const items = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const item of items) {
    const fullPath = path.join(dirPath, item.name);
    const relPath = path.relative(rootPath, fullPath).replace(/\\/g, '/');

    if (matchesDockerignore(relPath, rules)) {
      continue;
    }

    if (item.isSymbolicLink()) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
          continue;
        }
        throw err;
      }

      if (stat.isDirectory()) {
        // Detect symlink loops via inode tracking
        if (visitedInodes.has(stat.ino)) {
          continue;
        }
        visitedInodes.add(stat.ino);
        
        const entryIndex = entries.length;
        entries.push({ path: relPath, size: 0, isDirectory: true });
        walkDirectory(fullPath, rootPath, rules, entries, visitedInodes);
        visitedInodes.delete(stat.ino);

        // Back-fill directory size from its child file entries
        let dirSize = 0;
        for (let j = entryIndex + 1; j < entries.length; j++) {
          if (!entries[j].isDirectory) {
            dirSize += entries[j].size;
          }
        }
        entries[entryIndex].size = dirSize;
      } else {
        entries.push({ path: relPath, size: stat.size, isDirectory: false });
      }
    } else if (item.isDirectory()) {
      const stat = fs.statSync(fullPath);
      if (visitedInodes.has(stat.ino)) {
        continue;
      }
      visitedInodes.add(stat.ino);
      // Size will be computed from accumulated file entries after walk; store 0 for now
      const entryIndex = entries.length;
      entries.push({ path: relPath, size: 0, isDirectory: true });
      walkDirectory(fullPath, rootPath, rules, entries, visitedInodes);
      visitedInodes.delete(stat.ino);

      // Back-fill directory size from its child file entries
      let dirSize = 0;
      for (let j = entryIndex + 1; j < entries.length; j++) {
        if (!entries[j].isDirectory) {
          dirSize += entries[j].size;
        }
      }
      entries[entryIndex].size = dirSize;
    } else if (item.isFile()) {
      const stat = fs.statSync(fullPath);
      entries.push({ path: relPath, size: stat.size, isDirectory: false });
    }
  }
}

function matchesExcludablePattern(relPath: string, matchers: RegExp[]): boolean {
  return matchers.some((re) => re.test(relPath));
}

export function analyze(targetPath: string): AnalysisResult {
  const resolvedPath = path.resolve(targetPath);

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Path does not exist: ${resolvedPath}`);
  }

  const { rules, all: existingRules } = readDockerignore(resolvedPath);
  const entries: FileEntry[] = [];

  // Seed visited inodes with the root directory to avoid traversing back to it via symlinks
  const rootStat = fs.statSync(resolvedPath);
  const visitedInodes = new Set<number>([rootStat.ino]);

  walkDirectory(resolvedPath, resolvedPath, rules, entries, visitedInodes);

  const totalSizeBytes = entries
    .filter((e) => !e.isDirectory)
    .reduce((sum, e) => sum + e.size, 0);

  const fileCount = entries.filter((e) => !e.isDirectory).length;

  // Top offenders: directories + large files, sorted by size descending
  const topOffenders = [...entries]
    .sort((a, b) => b.size - a.size)
    .slice(0, 20);

  // Calculate which patterns apply and their savings
  const suggestedRules: PatternSuggestion[] = [];

  // Union of files covered by any suggested rule, used for the aggregate.

  const coveredFiles = new Set<string>();


  for (const def of EXCLUDABLE_PATTERNS) {
    // Skip patterns already covered by existing dockerignore. Only the exact
    // pattern counts as coverage: a bare `node_modules` rule excludes the root
    // directory alone, so nested instances still justify suggesting
    // `**/node_modules`, and the empty match list below keeps the suggestion
    // away when nothing is left to exclude.
    const alreadyCovered = existingRules.some((rule) => {
      const r = rule.replace(/\\/g, '/').replace(/\/$/, '');
      return r === def.pattern;
    });
    if (alreadyCovered) continue;

    // Find matching entries and sum their sizes
    const matchingEntries = entries.filter((e) =>
      matchesExcludablePattern(e.path, def.matchers)
    );

    if (matchingEntries.length === 0) continue;

    // For directories, use the directory size entry directly; avoid double-counting
    // by summing only top-level matched entries (not their children)
    const topLevelMatches = matchingEntries.filter((entry) => {
      return !matchingEntries.some(
        (other) => other.isDirectory && entry.path.startsWith(other.path + '/')
      );
    });

    const savings = topLevelMatches.reduce((sum, e) => sum + e.size, 0);

    // Remember which files this rule covers. Rules can overlap: **/*.pyc lives
    // inside **/__pycache__, so summing per-rule savings would double-count and
    // report a larger reduction than applying every rule actually delivers.
    for (const entry of matchingEntries) {
      if (!entry.isDirectory) coveredFiles.add(entry.path);
    }

    suggestedRules.push({
      pattern: def.pattern,
      reason: def.reason,
      estimatedSavingsBytes: savings,
    });
  }

  // Sort suggestions by savings descending
  suggestedRules.sort((a, b) => b.estimatedSavingsBytes - a.estimatedSavingsBytes);

  // Sum the union of covered files rather than the per-rule savings, so
  // overlapping rules cannot push the reported reduction past 100%.
  const uniqueSavingsBytes = entries
    .filter((e) => !e.isDirectory && coveredFiles.has(e.path))
    .reduce((sum, e) => sum + e.size, 0);

  const estimatedReducedSizeBytes = Math.max(0, totalSizeBytes - uniqueSavingsBytes);

  const reductionPercentage =
    totalSizeBytes > 0
      ? Math.round(
          ((totalSizeBytes - estimatedReducedSizeBytes) / totalSizeBytes) * 100 * 10
        ) / 10
      : 0;

  const dockerfileFound = fs.existsSync(path.join(resolvedPath, 'Dockerfile'));

  return {
    totalSizeBytes,
    totalSizeMB: Math.round((totalSizeBytes / 1024 / 1024) * 100) / 100,
    fileCount,
    topOffenders,
    existingDockerignoreRules: existingRules,
    suggestedRules,
    estimatedReducedSizeBytes,
    estimatedReducedSizeMB: Math.round((estimatedReducedSizeBytes / 1024 / 1024) * 100) / 100,
    reductionPercentage,
    analyzedPath: resolvedPath,
    dockerfileFound,
  };
}

export type { AnalysisResult, PatternSuggestion, FileEntry };
