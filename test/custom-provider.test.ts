import assert from "node:assert/strict";
import test from "node:test";
import { createCustomProviderIdentity, resolveCustomProvider } from "../src/runner.js";

test("resolves OpenAI-compatible provider configuration from environment values", () => {
  const provider = resolveCustomProvider(
    {
      type: "openai",
      baseUrlEnv: "FW_KIMI_K3_BASE_URL",
      apiKeyEnv: "FW_KIMI_K3_API_KEY",
      wireApi: "completions",
    },
    {
      FW_KIMI_K3_BASE_URL: "https://fw.example.test/v1",
      FW_KIMI_K3_API_KEY: "test-only-key",
    },
  );
  assert.deepEqual(provider, {
    type: "openai",
    baseUrl: "https://fw.example.test/v1",
    apiKey: "test-only-key",
    bearerToken: undefined,
    wireApi: "completions",
    azure: undefined,
  });
});

test("rejects missing and ambiguous custom-provider credentials", () => {
  assert.throws(
    () => resolveCustomProvider(
      { type: "openai", baseUrlEnv: "FW_KIMI_K3_BASE_URL", apiKeyEnv: "FW_KIMI_K3_API_KEY" },
      { FW_KIMI_K3_BASE_URL: "https://fw.example.test/v1" },
    ),
    /FW_KIMI_K3_API_KEY/,
  );
  assert.throws(
    () => resolveCustomProvider(
      {
        type: "openai",
        baseUrlEnv: "FW_KIMI_K3_BASE_URL",
        apiKeyEnv: "FW_KIMI_K3_API_KEY",
        bearerTokenEnv: "FW_KIMI_K3_BEARER_TOKEN",
      },
      {},
    ),
    /either apiKeyEnv or bearerTokenEnv/,
  );
  assert.throws(
    () => resolveCustomProvider(
      {
        type: "anthropic",
        baseUrlEnv: "ANTHROPIC_BASE_URL",
        apiKeyEnv: "ANTHROPIC_API_KEY",
        wireApi: "completions",
      },
      {
        ANTHROPIC_BASE_URL: "https://api.anthropic.com",
        ANTHROPIC_API_KEY: "test-only-key",
      },
    ),
    /not supported for Anthropic/,
  );
});

test("fingerprints provider endpoints without recording them in the contract identity", () => {
  const identity = createCustomProviderIdentity(
    {
      type: "openai",
      baseUrlEnv: "FW_KIMI_K3_BASE_URL",
      bearerTokenEnv: "FW_KIMI_K3_BEARER_TOKEN",
      wireApi: "completions",
    },
    { FW_KIMI_K3_BASE_URL: "https://fw.example.test/v1" },
  );
  assert.equal(identity.authentication, "bearer-token");
  assert.equal(identity.wireApi, "completions");
  assert.doesNotMatch(identity.endpointFingerprint, /fw\.example/);
  assert.match(identity.endpointFingerprint, /^[a-f0-9]{64}$/);
});
