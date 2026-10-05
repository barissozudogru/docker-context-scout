import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { analyze } from "../dist/index.js";

/**
 * Docker matches an ignore pattern against the path relative to the context
 * root. A bare `node_modules` drops the root directory only, so nested copies
 * travel to the daemon, and an analysis that silently drops them reports a
 * context smaller than the one Docker actually uploads.
 */

/** Build a throwaway project, run analyze on it, and clean up afterwards. */
function analyzeTree(t, dockerignore, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-walk-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  if (dockerignore !== null) {
    fs.writeFileSync(path.join(root, ".dockerignore"), dockerignore);
  }
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return analyze(root);
}

test("rejects a regular file as the analysis path", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-file-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "input.txt");
  fs.writeFileSync(file, "content");

  assert.throws(
    () => analyze(file),
    (error) => error instanceof Error && error.message === `Path is not a directory: ${file}`
  );
});

const NESTED_TREE = {
  "node_modules/root.bin": "R".repeat(100),
  "packages/a/node_modules/nested.bin": "N".repeat(200),
  "src/app.js": "A".repeat(10),
};

test("a hash in a rule is literal unless it starts the line", (t) => {
  const result = analyzeTree(t, "foo#bar\n", {
    foo: "root",
    "foo#bar": "ignored",
  });

  assert.deepEqual(result.existingDockerignoreRules, ["foo#bar"]);
  assert.equal(result.fileCount, 2);
  assert.ok(result.topOffenders.some((entry) => entry.path === "foo"));
  assert.ok(!result.topOffenders.some((entry) => entry.path === "foo#bar"));
});

test("root Dockerfile and .dockerignore remain in the context when ignored", (t) => {
  const result = analyzeTree(t, "*\n", {
    Dockerfile: "FROM scratch\n",
  });

  assert.equal(result.fileCount, 2);
  assert.equal(result.totalSizeBytes, "FROM scratch\n".length + "*\n".length);
  assert.deepEqual(
    result.topOffenders.map((entry) => entry.path).sort(),
    [".dockerignore", "Dockerfile"]
  );
});

test("a bare rule excludes only the root entry, nested copies stay in the context", (t) => {
  const result = analyzeTree(t, "node_modules\n", NESTED_TREE);

  // The daemon receives nested.bin, app.js and the .dockerignore itself.
  assert.equal(result.fileCount, 3);
  assert.equal(result.totalSizeBytes, 200 + 10 + "node_modules\n".length);
  assert.ok(
    result.topOffenders.some((e) => e.path === "packages/a/node_modules"),
    "the nested dependency directory should be reported as an offender"
  );
});

test("a recursive rule excludes the nested copies as well", (t) => {
  const result = analyzeTree(t, "**/node_modules\n", NESTED_TREE);

  // Both dependency trees go; app.js and the .dockerignore itself remain.
  assert.equal(result.fileCount, 2);
  assert.equal(result.totalSizeBytes, 10 + "**/node_modules\n".length);
});

test("nested copies behind a bare rule still earn the recursive suggestion", (t) => {
  const result = analyzeTree(t, "node_modules\n", NESTED_TREE);

  const suggestion = result.suggestedRules.find((r) => r.pattern === "**/node_modules");
  assert.ok(suggestion, "nested copies must trigger the **/node_modules suggestion");
  assert.equal(suggestion.estimatedSavingsBytes, 200);
});

test("a test directory suggestion matches the emitted Docker rule", (t) => {
  const result = analyzeTree(t, null, {
    "test/unit.js": "u".repeat(12),
  });

  const suggestion = result.suggestedRules.find((r) => r.pattern === "test");
  assert.ok(suggestion, "the root test directory must get a matching suggestion");
  assert.equal(suggestion.estimatedSavingsBytes, 12);
  assert.ok(!result.suggestedRules.some((r) => r.pattern === "tests"));
});

test("the environment glob matches every basename beginning with .env", (t) => {
  const result = analyzeTree(t, null, {
    ".environment": "e".repeat(17),
  });

  const suggestion = result.suggestedRules.find((r) => r.pattern === "**/.env*");
  assert.ok(suggestion, "the .env* rule must include matching basenames");
  assert.equal(suggestion.estimatedSavingsBytes, 17);
});

test("the markdown suggestion does not claim to exclude markdown extensions it cannot match", (t) => {
  const result = analyzeTree(t, null, {
    "README.md": "m".repeat(11),
    "guide.mdx": "x".repeat(13),
  });

  const suggestion = result.suggestedRules.find((r) => r.pattern === "**/*.md");
  assert.ok(suggestion, "the .md rule should be suggested for markdown files");
  assert.equal(suggestion.estimatedSavingsBytes, 11);
});

test("the markdown suggestion respects case-sensitive Docker matching", (t) => {
  const result = analyzeTree(t, null, {
    "README.MD": "m".repeat(11),
  });

  assert.ok(!result.suggestedRules.some((r) => r.pattern === "**/*.md"));
});

test("the recursive suggestion is not repeated once the recursive rule exists", (t) => {
  const result = analyzeTree(t, "**/node_modules\n", NESTED_TREE);

  assert.ok(!result.suggestedRules.some((r) => r.pattern === "**/node_modules"));
});

test("a root wildcard keeps deeper files in the context", (t) => {
  const result = analyzeTree(t, "*.md\n", {
    "README.md": "r".repeat(5),
    "docs/guide.md": "g".repeat(7),
  });

  assert.equal(result.fileCount, 2);
  assert.equal(result.totalSizeBytes, 7 + "*.md\n".length);
});

test("a recursive directory rule stays on segment boundaries", (t) => {
  const result = analyzeTree(t, "**/node_modules\n", {
    "xnode_modules/edge.bin": "E".repeat(50),
  });

  assert.equal(result.fileCount, 2);
  assert.equal(result.totalSizeBytes, 50 + "**/node_modules\n".length);
});

test("a mid-path '**' covers zero directories but keeps whole segments", (t) => {
  const result = analyzeTree(t, "a/**/b\n", {
    "a/b/inside.bin": "I".repeat(30),
    "a/x/b/deep.bin": "D".repeat(40),
    "a/x/y/b/verydeep.bin": "V".repeat(20),
    "ab/falsematch.bin": "F".repeat(50),
    "aa/b/edge.bin": "E".repeat(60),
    "src/app.js": "A".repeat(10),
  });

  // `a/**/b` covers zero or more directories between a and b, so a/b itself
  // goes too. The paths ab and aa/b stay: Docker matches `a` as one whole
  // directory name, so a rule that glues a onto the next segment would match
  // nothing at all.
  assert.equal(result.fileCount, 4);
  assert.equal(result.totalSizeBytes, 50 + 60 + 10 + "a/**/b\n".length);
});

test("a one-level wildcard does not reach past its own depth", (t) => {
  const result = analyzeTree(t, "*/temp*\n", {
    "somedir/temporary.txt": "t".repeat(4),
    "somedir/sub/temp.txt": "d".repeat(6),
    "temp.txt": "r".repeat(2),
  });

  assert.equal(result.fileCount, 3);
  assert.equal(result.totalSizeBytes, 6 + 2 + "*/temp*\n".length);
});

test("a trailing '**' behaves like the bare directory", (t) => {
  const result = analyzeTree(t, "logs/**\n", {
    "logs/a.txt": "a".repeat(3),
    "logs/deep/b.txt": "b".repeat(4),
    "src/app.js": "A".repeat(10),
  });

  // Everything under logs/ goes, app.js and the .dockerignore itself remain.
  assert.equal(result.fileCount, 2);
  assert.equal(result.totalSizeBytes, 10 + "logs/**\n".length);
});

test("a lone '**' excludes regular files but keeps Docker build control files", (t) => {
  const result = analyzeTree(t, "**\n", {
    "src/app.js": "A".repeat(10),
    "README.md": "r".repeat(5),
  });

  assert.equal(result.fileCount, 1);
  assert.equal(result.totalSizeBytes, "**\n".length);
  assert.deepEqual(result.topOffenders.map((entry) => entry.path), [".dockerignore"]);
});

test("inaccessible directories bubble up permission errors", (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX permissions are not enforced on Windows");
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-perm-"));
  const secretDir = path.join(root, "secret");
  fs.mkdirSync(secretDir);
  fs.writeFileSync(path.join(secretDir, "file.txt"), "hello");
  fs.chmodSync(secretDir, 0);

  t.after(() => {
    fs.chmodSync(secretDir, 0o755);
    fs.rmSync(root, { recursive: true, force: true });
  });

  assert.throws(
    () => analyze(root),
    (err) => err.code === "EACCES" || err.code === "EPERM"
  );
});

test("broken symlinks are skipped without error", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-sym-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.symlinkSync("nonexistent", path.join(root, "broken_link"));
  fs.writeFileSync(path.join(root, "app.js"), "hello");

  const result = analyze(root);
  assert.equal(result.fileCount, 1);
  assert.equal(result.totalSizeBytes, 5);
});

test("many matching directories calculate savings without quadratic slowdown", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-scale-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const count = 1200;
  for (let i = 0; i < count; i++) {
    const directory = path.join(root, `package-${i}`, "node_modules");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "dependency.js"), "x");
  }

  analyze(root);
  const start = performance.now();
  const result = analyze(root);
  const elapsed = performance.now() - start;

  assert.equal(result.fileCount, count);
  const suggestion = result.suggestedRules.find((r) => r.pattern === "**/node_modules");
  assert.ok(suggestion, "matching rule must be suggested");

  assert.equal(suggestion.estimatedSavingsBytes, count);
  assert.ok(elapsed < 300, `analysis took ${elapsed.toFixed(1)}ms, expected under 300ms`);
});
