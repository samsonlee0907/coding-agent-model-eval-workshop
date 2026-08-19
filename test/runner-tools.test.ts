import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  prepareCopilotRuntimeDirectory,
  resolveCopilotCliPath,
  resolveSdkToolAllowlist,
} from "../src/runner.js";

test("maps benchmark tool capabilities to source-qualified SDK built-ins", () => {
  const expectedShell = process.platform === "win32" ? "powershell" : "bash";
  assert.deepEqual(resolveSdkToolAllowlist(["read", "edit", "shell"]), [
    "builtin:view",
    "builtin:glob",
    "builtin:edit",
    `builtin:${expectedShell}`,
  ]);
});

test("creates the isolated Copilot home before the runtime receives a prompt", () => {
  const artifactsDirectory = mkdtempSync(join(tmpdir(), "benchmark-runtime-"));
  try {
    const runtimeDirectory = prepareCopilotRuntimeDirectory(artifactsDirectory);
    assert.equal(runtimeDirectory, join(artifactsDirectory, "copilot-runtime"));
    assert.equal(existsSync(runtimeDirectory), true);
  } finally {
    rmSync(artifactsDirectory, { recursive: true, force: true });
  }
});

test("prefers an explicit or discovered external Copilot CLI runtime", () => {
  assert.equal(
    resolveCopilotCliPath(
      { BENCHMARK_COPILOT_CLI_PATH: "C:\\tools\\copilot.exe" },
      "win32",
      () => "ignored",
    ),
    "C:\\tools\\copilot.exe",
  );
  assert.equal(
    resolveCopilotCliPath({}, "win32", (command) => {
      assert.equal(command, "copilot.exe");
      return "C:\\installed\\copilot.exe";
    }),
    "C:\\installed\\copilot.exe",
  );
  assert.equal(resolveCopilotCliPath({}, "linux", () => null), undefined);
});
