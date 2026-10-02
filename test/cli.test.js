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

for (const value of [" ", "0x10", "Infinity"]) {
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
