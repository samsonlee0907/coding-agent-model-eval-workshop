import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createQuickstartWorkspace, parseQuickstartOptions } from "../src/quickstart.js";
import { resolveValidationCommand } from "../src/validation.js";

test("quickstart creates a local baseline from task and optional source without a remote", () => {
  const root = mkdtempSync(join(tmpdir(), "benchmark-quickstart-"));
  const source = join(root, "source");
  const output = join(root, "output");
  writeFileSync(join(root, "ignored.txt"), "outside source");
  writeFileSync(join(root, "task.txt"), "Build a counter application.");
  mkdirSync(source);
  writeFileSync(join(source, "reference.txt"), "source artifact");

  const quickstart = createQuickstartWorkspace({
    task: "Build a counter application.",
    sourcePath: source,
    outputDirectory: output,
  });

  assert.match(quickstart.baselineCommitSha, /^[a-f0-9]{40}$/);
  assert.match(quickstart.containerFingerprint, /^win32-node-/);
  assert.equal(quickstart.config.contract.task.validationCommand, "auto");
  assert.equal(quickstart.config.contract.customProvider?.baseUrlEnv, "MODEL_BASE_URL");
  assert.equal(existsSync(join(quickstart.workspacePath, ".git")), true);
  assert.equal(readFileSync(join(quickstart.workspacePath, "reference.txt"), "utf8"), "source artifact");
  assert.equal(readFileSync(join(quickstart.workspacePath, "BENCHMARK_TASK.md"), "utf8"), "Build a counter application.\n");
});

test("quickstart parses generic candidate provider options", () => {
  assert.deepEqual(parseQuickstartOptions([
    "--task", "Build an app",
    "--model", "claude-example",
    "--provider", "foundry-anthropic",
    "--provider-type", "anthropic",
    "--base-url-env", "FOUNDRY_ANTHROPIC_BASE_URL",
    "--api-key-env", "FOUNDRY_ANTHROPIC_API_KEY",
    "--deployment", "claude-region-a",
  ]), {
    task: "Build an app",
    model: "claude-example",
    providerLabel: "foundry-anthropic",
    providerType: "anthropic",
    baseUrlEnv: "FOUNDRY_ANTHROPIC_BASE_URL",
    apiKeyEnv: "FOUNDRY_ANTHROPIC_API_KEY",
    bearerTokenEnv: undefined,
    wireApi: undefined,
    deployment: "claude-region-a",
    outputDirectory: undefined,
    sourcePath: undefined,
  });
  assert.throws(
    () => parseQuickstartOptions(["--task", "one", "--task-file", "two.md"]),
    /either --task or --task-file/,
  );
  assert.throws(
    () => parseQuickstartOptions(["--task", "one", "--provider-type", "unknown"]),
    /openai, azure, or anthropic/,
  );
});

test("automatic validation selects project scripts and rejects absent scripts", () => {
  const directory = mkdtempSync(join(tmpdir(), "benchmark-validation-"));
  writeFileSync(join(directory, "package.json"), JSON.stringify({
    scripts: { test: "node --test", build: "tsc" },
  }));
  assert.equal(resolveValidationCommand("auto", directory), "npm test && npm run build");

  writeFileSync(join(directory, "package.json"), JSON.stringify({ scripts: {} }));
  assert.match(resolveValidationCommand("auto", directory), /neither a test nor build script/);
});
