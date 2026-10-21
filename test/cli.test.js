import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

test("threshold rejects a numeric prefix followed by invalid characters", () => {
  const cliPath = path.resolve("dist/cli.js");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "docker-context-scout-test-"));
  let result;
  try {
    result = spawnSync(process.execPath, [cliPath, "--threshold", "1garbage"], {
      cwd,
      encoding: "utf8",
    });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }

  assert.equal(result.status, 1);
  assert.match(result.stderr, /invalid threshold value/);
});

test("rejects multiple analysis paths instead of silently ignoring the extra paths", () => {
  const cliPath = path.resolve("dist/cli.js");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "docker-context-scout-test-"));
  const first = path.join(cwd, "first");
  const second = path.join(cwd, "second");
  fs.mkdirSync(first);
  fs.mkdirSync(second);
  try {
    const result = spawnSync(process.execPath, [cliPath, first, second], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /only one analysis path may be provided/);
    assert.equal(result.stdout, "");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

for (const value of [" ", "0x10", "Infinity", "1e308"]) {
  test(`threshold rejects non-decimal input ${JSON.stringify(value)}`, () => {
    const cliPath = path.resolve("dist/cli.js");
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "docker-context-scout-test-"));
    try {
      const result = spawnSync(process.execPath, [cliPath, "--threshold", value], { cwd, encoding: "utf8" });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /invalid threshold value/);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
}

for (const value of ["0", "0.5", ".5", "+1", "1e1", "1.5e-1"]) {
  test(`threshold accepts complete decimal input ${JSON.stringify(value)}`, () => {
    const cliPath = path.resolve("dist/cli.js");
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "docker-context-scout-test-"));
    try {
      const result = spawnSync(process.execPath, [cliPath, "--threshold", value], { cwd, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stderr, /invalid threshold value/);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
}

test("default report shows all retained top offenders", () => {
  const cliPath = path.resolve("dist/cli.js");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "docker-context-scout-test-"));
  try {
    for (let i = 0; i < 11; i++) {
      fs.writeFileSync(path.join(cwd, `file-${i}.txt`), "x");
    }

    const result = spawnSync(process.execPath, [cliPath, cwd], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal((result.stdout.match(/^  \[file\]/gm) ?? []).length, 11);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("threshold only shows entries strictly above the configured size", () => {
  const cliPath = path.resolve("dist/cli.js");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "docker-context-scout-test-"));
  try {
    fs.writeFileSync(path.join(cwd, "exact.bin"), Buffer.alloc(1024 * 1024));
    fs.writeFileSync(path.join(cwd, "above.bin"), Buffer.alloc(2 * 1024 * 1024));

    const result = spawnSync(process.execPath, [cliPath, cwd, "--threshold", "1"], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /exact\.bin/);
    assert.match(result.stdout, /above\.bin/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("explicit zero threshold hides zero-byte entries", () => {
  const cliPath = path.resolve("dist/cli.js");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "docker-context-scout-test-"));
  try {
    fs.writeFileSync(path.join(cwd, "content.bin"), "x");
    fs.writeFileSync(path.join(cwd, "zero.bin"), "");

    const result = spawnSync(process.execPath, [cliPath, cwd, "--threshold", "0"], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /zero\.bin/);
    assert.match(result.stdout, /content\.bin/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("json mode combined with fix outputs parseable JSON on stdout and status on stderr", () => {
  const cliPath = path.resolve("dist/cli.js");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "docker-context-scout-test-"));
  try {
    fs.mkdirSync(path.join(cwd, ".git"));
    fs.writeFileSync(path.join(cwd, ".git", "HEAD"), "ref: refs/heads/main\n");

    const result = spawnSync(process.execPath, [cliPath, cwd, "--json", "--fix"], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(typeof parsed, "object");
    assert.match(result.stderr, /Created .*?\.dockerignore with \d+ rules/);

    const secondResult = spawnSync(process.execPath, [cliPath, cwd, "--json", "--fix"], {
      encoding: "utf8",
    });
    assert.equal(secondResult.status, 0, secondResult.stderr);
    JSON.parse(secondResult.stdout);
    assert.match(secondResult.stderr, /Nothing to add - no new suggestions\./);

    fs.mkdirSync(path.join(cwd, "node_modules"));
    fs.writeFileSync(path.join(cwd, "node_modules", "package.json"), "{}");
    const thirdResult = spawnSync(process.execPath, [cliPath, cwd, "--json", "--fix"], {
      encoding: "utf8",
    });
    assert.equal(thirdResult.status, 0, thirdResult.stderr);
    JSON.parse(thirdResult.stdout);
    assert.match(thirdResult.stderr, /Appended \d+ rules to /);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

