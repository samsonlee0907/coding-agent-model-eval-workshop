import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deriveFoundryInferenceBase } from "../src/foundry-endpoint.js";
import { createFoundryProviderIdentity, loadBenchmarkConfig, resolveFoundryProvider } from "../src/runner.js";

const environment = {
  FOUNDRY_ENDPOINT: "https://workshop.services.ai.azure.com",
  FOUNDRY_API_KEY: "test-only-key",
};

test("derives Foundry OpenAI and Anthropic routes from the canonical resource root", () => {
  assert.equal(
    resolveFoundryProvider({ type: "openai" }, environment).baseUrl,
    "https://workshop.openai.azure.com/openai/v1",
  );
  assert.equal(
    resolveFoundryProvider({ type: "anthropic" }, environment).baseUrl,
    "https://workshop.services.ai.azure.com/anthropic",
  );
});

test("rejects non-canonical Foundry endpoints instead of forwarding a likely wrong URL", () => {
  for (const endpoint of [
    "https://workshop.openai.azure.com",
    "https://workshop.services.ai.azure.com/anthropic",
    "https://workshop.services.ai.azure.com/api/projects/evaluation",
    "https://gateway.example.test/v1",
    "http://workshop.services.ai.azure.com",
    "https://workshop.services.ai.azure.com?api-version=1",
  ]) {
    assert.throws(() => deriveFoundryInferenceBase(endpoint, "openai"), /FOUNDRY_ENDPOINT|Foundry resource URL/);
  }
});

test("requires the single fixed Foundry credential environment variable", () => {
  const environmentWithoutKey = {
    FOUNDRY_ENDPOINT: environment.FOUNDRY_ENDPOINT,
  };
  assert.throws(
    () => resolveFoundryProvider({ type: "openai" }, environmentWithoutKey),
    /FOUNDRY_API_KEY is required but is not set\. Set it in the current PowerShell session only: \$env:FOUNDRY_API_KEY = "<your-foundry-api-key>"/,
  );
  assert.doesNotThrow(() => resolveFoundryProvider({ type: "openai" }, environment));
});

test("rejects legacy custom-provider benchmark configuration at load time", () => {
  const path = join(mkdtempSync(join(tmpdir(), "benchmark-config-")), "legacy.json");
  writeFileSync(path, JSON.stringify({ contract: { customProvider: { type: "openai" } } }));
  assert.throws(() => loadBenchmarkConfig(path), /Legacy\/custom provider configuration is unsupported/);
});

test("fingerprints the derived endpoint and discloses the selected compatibility adaptation", () => {
  const identity = createFoundryProviderIdentity({ type: "openai" }, environment);
  assert.equal(identity.requestAdaptation, "openai-null-refusal-sanitizer");
  assert.match(identity.endpointFingerprint, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(identity.endpointFingerprint, /workshop/);
  assert.equal(
    createFoundryProviderIdentity({ type: "anthropic" }, environment).requestAdaptation,
    "strip-temperature",
  );
});
