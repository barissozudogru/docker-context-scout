import { test } from "node:test";
import assert from "node:assert/strict";
import { EXCLUDABLE_PATTERNS_FOR_TEST as RULES } from "../dist/index.js";

/**
 * Docker matches a bare .dockerignore pattern against the context root only.
 * `*.md` skips root markdown but keeps `docs/guide.md`; `__pycache__` skips a
 * root cache directory but keeps every nested one. Matching anywhere in the
 * tree requires the `**\/` prefix.
 *
 * Savings here are computed with regexes. So whenever a rule's matchers can hit
 * a nested path, the pattern it writes into .dockerignore must be recursive too,
 * or the tool reports a saving that applying its own advice will not deliver.
 */

/** A matcher is root-anchored if it can only ever match from the start of the path. */
function isRootAnchored(re) {
  const src = re.source;
  if (src.startsWith("^")) return true;
  // `(^|\/)` matches either the start or a path separator, so it is not anchored.
  return false;
}

test("every rule with an unanchored matcher emits a recursive pattern", () => {
  const offenders = [];
  for (const rule of RULES) {
    const anyUnanchored = rule.matchers.some((m) => !isRootAnchored(m));
    const isRecursivePattern = rule.pattern.startsWith("**/");
    if (anyUnanchored && !isRecursivePattern) {
      offenders.push(
        `${rule.pattern} counts nested matches but writes a root-only rule`
      );
    }
  }
  assert.deepEqual(offenders, []);
});

test("every rule with only anchored matchers emits a root pattern", () => {
  const offenders = [];
  for (const rule of RULES) {
    const allAnchored = rule.matchers.every((m) => isRootAnchored(m));
    if (allAnchored && rule.pattern.startsWith("**/")) {
      offenders.push(
        `${rule.pattern} writes a recursive rule but only counts root matches`
      );
    }
  }
  assert.deepEqual(offenders, []);
});

test("no rule conflates several distinct globs into one pattern", () => {
  // The original `test` rule matched tests/, __tests__/, *.test.ts and *.spec.ts
  // but wrote the single word `test`, which matches none of them. A pattern with
  // a literal basename cannot stand in for several different shapes, so each
  // rule now carries matchers of one shape only.
  for (const rule of RULES) {
    const shapes = new Set(
      rule.matchers.map((m) => (m.source.includes("\\.") && m.source.endsWith("$") ? "extension" : "directory"))
    );
    assert.equal(
      shapes.size,
      1,
      `rule "${rule.pattern}" mixes directory and extension matchers`
    );
  }
});

test("Python virtualenvs are covered", () => {
  const patterns = RULES.map((r) => r.pattern);
  assert.ok(patterns.includes("**/.venv"));
  assert.ok(patterns.includes("**/venv"));
});

test("matchers actually match the paths their rule is named for", () => {
  const cases = [
    ["**/__pycache__", "backend/app/__pycache__/main.pyc"],
    ["**/node_modules", "packages/api/node_modules/left-pad/index.js"],
    ["**/.venv", "backend/.venv/lib/python3.12/site-packages/x.py"],
    ["**/*.md", "docs/deep/guide.md"],
    ["**/*.test.*", "src/deep/thing.test.ts"],
    ["**/__tests__", "src/__tests__/thing.js"],
    [".git", ".git/objects/ab/cdef"],
    ["dist", "dist/index.js"],
  ];
  for (const [pattern, samplePath] of cases) {
    const rule = RULES.find((r) => r.pattern === pattern);
    assert.ok(rule, `no rule for ${pattern}`);
    assert.ok(
      rule.matchers.some((m) => m.test(samplePath)),
      `${pattern} does not match ${samplePath}`
    );
  }
});

test("root-anchored rules do not claim nested savings", () => {
  const dist = RULES.find((r) => r.pattern === "dist");
  // A nested dist/ is a real directory but Docker's `dist` will not exclude it,
  // so the matcher must not count it either.
  assert.ok(!dist.matchers.some((m) => m.test("packages/web/dist/index.js")));
});
