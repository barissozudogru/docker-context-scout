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

function readDockerignore(dirPath: string): string[] {
  const dockerignorePath = path.join(dirPath, '.dockerignore');
  if (!fs.existsSync(dockerignorePath)) {
    return [];
  }
  return fs
    .readFileSync(dockerignorePath, 'utf-8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

function matchesDockerignore(relPath: string, rules: string[]): boolean {
  for (const rule of rules) {
    const normalized = rule.replace(/\\/g, '/').replace(/\/$/, '');
    if (normalized === relPath) return true;
    if (relPath.startsWith(normalized + '/')) return true;
    const base = path.basename(relPath);
    if (normalized.includes('*')) {
      const escaped = normalized.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      if (new RegExp(`^${escaped}$`).test(base)) return true;
      if (new RegExp(`^${escaped}$`).test(relPath)) return true;
    }
  }
  return false;
}

function walkDirectory(
  dirPath: string,
  rootPath: string,
  existingRules: string[],
  entries: FileEntry[]
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

    if (matchesDockerignore(relPath, existingRules)) {
      continue;
    }

    if (item.isDirectory()) {
      let size = 0;
      try {
        size = getDirectorySize(fullPath);
      } catch {
        size = 0;
      }
      entries.push({ path: relPath, size, isDirectory: true });
      walkDirectory(fullPath, rootPath, existingRules, entries);
    } else if (item.isFile() || item.isSymbolicLink()) {
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

function getDirectorySize(dirPath: string): number {
  let total = 0;
  let items: fs.Dirent[];
  try {
    items = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const item of items) {
    const fullPath = path.join(dirPath, item.name);
    if (item.isDirectory()) {
      total += getDirectorySize(fullPath);
    } else if (item.isFile()) {
      try {
        total += fs.statSync(fullPath).size;
      } catch {
        // ignore unreadable files
      }
    }
  }
  return total;
}

function matchesExcludablePattern(relPath: string, matchers: RegExp[]): boolean {
  return matchers.some((re) => re.test(relPath));
}

export function analyze(targetPath: string): AnalysisResult {
  const resolvedPath = path.resolve(targetPath);

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Path does not exist: ${resolvedPath}`);
  }

  const existingRules = readDockerignore(resolvedPath);
  const entries: FileEntry[] = [];

  walkDirectory(resolvedPath, resolvedPath, existingRules, entries);

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
  };
}

export type { AnalysisResult, PatternSuggestion, FileEntry };
