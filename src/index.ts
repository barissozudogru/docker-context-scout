import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FileEntry, AnalysisResult, PatternSuggestion } from './types.js';

const EXCLUDABLE_PATTERNS: Array<{ pattern: string; matchers: RegExp[]; reason: string }> = [
  {
    pattern: '.git',
    matchers: [/^\.git(\/|$)/],
    reason: 'Git metadata is never needed in Docker images',
  },
  {
    pattern: 'node_modules',
    matchers: [/node_modules(\/|$)/],
    reason: 'Dependencies are reinstalled during build via npm/yarn/pnpm install',
  },
  {
    pattern: '__pycache__',
    matchers: [/__pycache__(\/|$)/, /\.pyc$/],
    reason: 'Python bytecode cache is regenerated at runtime',
  },
  {
    pattern: '.env*',
    matchers: [/\.env(\.|$)/, /^\.env$/],
    reason: 'Environment files must never be baked into images',
  },
  {
    pattern: '*.md',
    matchers: [/\.md$/i, /\.mdx$/i],
    reason: 'Documentation files are not needed at runtime',
  },
  {
    pattern: 'test',
    matchers: [/^tests?(\/|$)/, /__tests__(\/|$)/, /\.test\.[jt]sx?$/, /\.spec\.[jt]sx?$/],
    reason: 'Test files and directories are not needed in production images',
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
    pattern: '*.log',
    matchers: [/\.log$/],
    reason: 'Log files are generated at runtime and must not be baked in',
  },
  {
    pattern: '.DS_Store',
    matchers: [/\.DS_Store$/],
    reason: 'macOS metadata files are irrelevant in Linux containers',
  },
  {
    pattern: 'Thumbs.db',
    matchers: [/Thumbs\.db$/],
    reason: 'Windows thumbnail cache files are irrelevant in Linux containers',
  },
  {
    pattern: '.terraform',
    matchers: [/^\.terraform(\/|$)/],
    reason: 'Terraform state and provider cache should not be copied into images',
  },
  {
    pattern: '*.tfstate*',
    matchers: [/\.tfstate/],
    reason: 'Terraform state files may contain secrets and are not needed at runtime',
  },
];

function stripInlineComment(line: string): string {
  // Docker only honours '#' at column 1 as a comment; a '#' mid-line is part of
  // the pattern. For comparison we drop anything after the first inline '#',
  // so a hand-annotated rule is still recognised as covering its pattern.
  const hashIndex = line.indexOf('#');
  return hashIndex > 0 ? line.slice(0, hashIndex).trim() : line;
}

function readDockerignore(dirPath: string): { positive: string[]; negative: string[]; all: string[] } {
  const dockerignorePath = path.join(dirPath, '.dockerignore');
  if (!fs.existsSync(dockerignorePath)) {
    return { positive: [], negative: [], all: [] };
  }
  const lines = fs
    .readFileSync(dockerignorePath, 'utf-8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map(stripInlineComment)
    .filter((l) => l);

  const positive = lines.filter((l) => !l.startsWith('!'));
  const negative = lines.filter((l) => l.startsWith('!')).map((l) => l.slice(1));
  return { positive, negative, all: lines };
}

/**
 * Convert a single .dockerignore glob rule into a RegExp.
 * Docker's glob semantics:
 *   - '*' matches any sequence of non-separator characters (not '/')
 *   - '**' matches any sequence including separators
 *   - '?' matches a single non-separator character
 *   - A leading '/' anchors to the root; without it, the pattern matches anywhere in the path
 */
function dockerignoreGlobToRegex(rule: string): RegExp {
  const normalized = rule.replace(/\\/g, '/').replace(/\/$/, '');

  // Anchor: if the rule contains a slash (other than trailing), it is relative to root
  const anchored = normalized.startsWith('/') || normalized.includes('/');
  const stripped = normalized.startsWith('/') ? normalized.slice(1) : normalized;

  let reStr = '';
  let i = 0;
  while (i < stripped.length) {
    if (stripped[i] === '*' && stripped[i + 1] === '*') {
      // '**' — match anything including slashes
      reStr += '.*';
      i += 2;
      // consume surrounding slashes: /**/  or leading /**/
      if (stripped[i] === '/') i++;
    } else if (stripped[i] === '*') {
      // '*' — match anything except '/'
      reStr += '[^/]*';
      i++;
    } else if (stripped[i] === '?') {
      reStr += '[^/]';
      i++;
    } else {
      // Escape regex metacharacters
      reStr += stripped[i].replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i++;
    }
  }

  if (anchored) {
    // Pattern must match from the start of the relative path
    return new RegExp(`^${reStr}(/.*)?$`);
  } else {
    // Pattern may match anywhere as a path segment
    return new RegExp(`(^|/)${reStr}(/.*)?$`);
  }
}

function matchesDockerignore(
  relPath: string,
  positive: string[],
  negative: string[]
): boolean {
  let matched = false;

  for (const rule of positive) {
    const re = dockerignoreGlobToRegex(rule);
    if (re.test(relPath)) {
      matched = true;
    }
  }

  if (matched) {
    // A negation pattern re-includes the file
    for (const rule of negative) {
      const re = dockerignoreGlobToRegex(rule);
      if (re.test(relPath)) {
        matched = false;
      }
    }
  }

  return matched;
}

function walkDirectory(
  dirPath: string,
  rootPath: string,
  positiveRules: string[],
  negativeRules: string[],
  entries: FileEntry[],
  visitedInodes: Set<number>
): void {
  let items: fs.Dirent[];
  try {
    items = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const item of items) {
    const fullPath = path.join(dirPath, item.name);
    const relPath = path.relative(rootPath, fullPath).replace(/\\/g, '/');

    if (matchesDockerignore(relPath, positiveRules, negativeRules)) {
      continue;
    }

    if (item.isSymbolicLink()) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        // Detect symlink loops via inode tracking
        if (visitedInodes.has(stat.ino)) {
          continue;
        }
        visitedInodes.add(stat.ino);
        
        const entryIndex = entries.length;
        entries.push({ path: relPath, size: 0, isDirectory: true });
        walkDirectory(fullPath, rootPath, positiveRules, negativeRules, entries, visitedInodes);
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
      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }
      if (visitedInodes.has(stat.ino)) {
        continue;
      }
      visitedInodes.add(stat.ino);
      // Size will be computed from accumulated file entries after walk; store 0 for now
      const entryIndex = entries.length;
      entries.push({ path: relPath, size: 0, isDirectory: true });
      walkDirectory(fullPath, rootPath, positiveRules, negativeRules, entries, visitedInodes);
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
      let size = 0;
      try {
        size = fs.statSync(fullPath).size;
      } catch {
        size = 0;
      }
      entries.push({ path: relPath, size, isDirectory: false });
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

  const { positive: positiveRules, negative: negativeRules, all: existingRules } = readDockerignore(resolvedPath);
  const entries: FileEntry[] = [];

  // Seed visited inodes with the root directory to avoid traversing back to it via symlinks
  const rootStat = fs.statSync(resolvedPath);
  const visitedInodes = new Set<number>([rootStat.ino]);

  walkDirectory(resolvedPath, resolvedPath, positiveRules, negativeRules, entries, visitedInodes);

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

  for (const def of EXCLUDABLE_PATTERNS) {
    // Skip patterns already covered by existing dockerignore
    const alreadyCovered = existingRules.some((rule) => {
      const r = rule.replace(/\\/g, '/').replace(/\/$/, '');
      return r === def.pattern || r === def.pattern.replace(/\*\//g, '');
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

    suggestedRules.push({
      pattern: def.pattern,
      reason: def.reason,
      estimatedSavingsBytes: savings,
    });
  }

  // Sort suggestions by savings descending
  suggestedRules.sort((a, b) => b.estimatedSavingsBytes - a.estimatedSavingsBytes);

  const estimatedReducedSizeBytes = Math.max(
    0,
    totalSizeBytes - suggestedRules.reduce((sum, r) => sum + r.estimatedSavingsBytes, 0)
  );

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
