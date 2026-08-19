import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createQuickstartWorkspace, parseQuickstartOptions } from "../src/quickstart.js";
import { resolveValidationCommand, runValidation } from "../src/validation.js";
import { scrubFoundryEnvironment } from "../src/validation.js";

test("quickstart creates a local baseline with the Foundry-only provider contract", () => {
  const root = mkdtempSync(join(tmpdir(), "benchmark-quickstart-"));
  const source = join(root, "source");
  const output = join(root, "output");
  mkdirSync(source);
  writeFileSync(join(source, "reference.txt"), "source artifact");

  const quickstart = createQuickstartWorkspace({
    task: "Build a counter application.",
    sourcePath: source,
    outputDirectory: output,
    model: "gpt-5.6-terra",
    provider: "openai",
  });

  assert.match(quickstart.baselineCommitSha, /^[a-f0-9]{40}$/);
  assert.equal(quickstart.config.contract.foundryProvider.type, "openai");
  assert.equal(quickstart.config.contract.execution.reasoningEffort, "high");
  assert.equal(existsSync(join(quickstart.workspacePath, ".git")), true);
  assert.equal(readFileSync(join(quickstart.workspacePath, "reference.txt"), "utf8"), "source artifact");
  assert.doesNotMatch(readFileSync(quickstart.configPath, "utf8"), /services\.ai\.azure\.com/);
});

test("quickstart accepts only exact Foundry provider values and rejects removed configuration", () => {
  assert.deepEqual(parseQuickstartOptions([
    "--task", "Build an app", "--model", "claude-opus-5", "--provider", "anthropic", "--deployment", "opus",
  ]), {
    task: "Build an app",
    model: "claude-opus-5",
    provider: "anthropic",
    deployment: "opus",
    outputDirectory: undefined,
    sourcePath: undefined,
    reasoningEffort: undefined,
  });
  assert.throws(() => parseQuickstartOptions(["--task", "one", "--model", "gpt"]), /--provider is required/);
  assert.throws(() => parseQuickstartOptions(["--task", "one", "--model", "gpt", "--provider", "azure"]), /exactly openai or anthropic/);
  assert.throws(() => parseQuickstartOptions(["--task", "one", "--model", "gpt", "--provider", "openai", "--foundry"]), /Unsupported option --foundry/);
  assert.throws(() => parseQuickstartOptions(["--task", "one", "--model", "gpt", "--provider", "openai", "--base-url-env", "OTHER"]), /Unsupported option --base-url-env/);
});

test("automatic validation selects project scripts and reports absent metadata", async () => {
  const directory = mkdtempSync(join(tmpdir(), "benchmark-validation-"));
  writeFileSync(join(directory, "package.json"), JSON.stringify({ scripts: { test: "node --test", build: "tsc" } }));
  assert.equal(resolveValidationCommand("auto", directory), "npm test && npm run build");
  writeFileSync(join(directory, "package.json"), JSON.stringify({ scripts: {} }));
  const result = await runValidation(resolveValidationCommand("auto", directory), directory, 5_000);
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /neither a test nor build script/);
});

test("agent and validation subprocess environments exclude Foundry credentials", () => {
  const environment = scrubFoundryEnvironment({
    PATH: "safe-path",
    FOUNDRY_ENDPOINT: "https://resource.services.ai.azure.com",
    FOUNDRY_API_KEY: "test-only-key",
  });
  assert.equal(environment.PATH, "safe-path");
  assert.equal(environment.FOUNDRY_ENDPOINT, undefined);
  assert.equal(environment.FOUNDRY_API_KEY, undefined);
});
