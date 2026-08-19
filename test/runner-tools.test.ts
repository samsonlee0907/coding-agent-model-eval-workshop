import assert from "node:assert/strict";
import test from "node:test";
import { resolveCopilotCliPath, resolveSdkToolAllowlist } from "../src/runner.js";

test("maps benchmark tool capabilities to source-qualified SDK built-ins", () => {
  const expectedShell = process.platform === "win32" ? "powershell" : "bash";
  assert.deepEqual(resolveSdkToolAllowlist(["read", "edit", "shell"]), [
    "builtin:view",
    "builtin:glob",
    "builtin:apply_patch",
    `builtin:${expectedShell}`,
  ]);
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
