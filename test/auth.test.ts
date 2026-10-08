import assert from "node:assert/strict";
import test from "node:test";
import { bearerTokenProvider, foundryScope, providerSchema } from "../src/auth.js";
import { resolveFoundryProvider, createFoundryProviderIdentity } from "../src/runner.js";
import { parseQuickstartOptions } from "../src/quickstart.js";
import { parseEvaluationOptions } from "../src/evaluator-options.js";
const endpoint = { FOUNDRY_ENDPOINT: "https://fixture.services.ai.azure.com" };

test("key/completions legacy behavior and explicit Responses are preserved", () => {
  assert.throws(() => resolveFoundryProvider({ type: "openai" }, endpoint), /FOUNDRY_API_KEY/);
  assert.equal(resolveFoundryProvider({ type: "openai" }, { ...endpoint, FOUNDRY_API_KEY: "fixture-key" }).wireApi, "completions");
  assert.equal(resolveFoundryProvider({ type: "openai", wireApi: "responses" }, { ...endpoint, FOUNDRY_API_KEY: "fixture-key" }).wireApi, "responses");
});
test("Entra needs no key; identity and protocol are recorded without secrets", () => {
  const config = { type: "openai" as const, wireApi: "responses" as const, auth: { mode: "entra" as const, credential: "azure-cli" as const } };
  const provider = resolveFoundryProvider(config, endpoint);
  assert.equal(provider.apiKey, undefined); assert.equal(typeof provider.bearerTokenProvider, "function");
  const identity = createFoundryProviderIdentity(config, { ...endpoint, FOUNDRY_API_KEY: "UNUSED-SECRET" });
  assert.equal(identity.auth?.mode, "entra"); assert.equal(identity.wireApi, "responses");
  assert.doesNotMatch(JSON.stringify(identity), /UNUSED-SECRET|fixture\.services/);
});
test("refresh uses Azure Identity provider on demand and coalesces concurrent acquisition", async () => {
  let calls = 0, token = "first";
  const get = bearerTokenProvider({ mode: "entra", credential: "azure-cli" }, {
    async getToken(scope) {
      assert.equal(scope, foundryScope); calls++;
      await new Promise((r) => setImmediate(r));
      return { token, expiresOnTimestamp: Date.now() + 60000 };
    },
  });
  assert.deepEqual(await Promise.all([get(), get(), get()]), ["first", "first", "first"]); assert.equal(calls, 1);
  token = "refreshed";
  assert.equal(await get(), "refreshed"); assert.equal(calls, 2);
});
test("failed credential does not fall back, leak diagnostics or accept expired tokens", async () => {
  const auth = { mode: "entra" as const, credential: "azure-cli" as const };
  const get = bearerTokenProvider(auth, { async getToken() { throw new Error("secret=PRIVATE-TOKEN"); } });
  await assert.rejects(get, (e: Error) => /No key or identity fallback/.test(e.message) && !e.message.includes("PRIVATE-TOKEN"));
  await assert.rejects(bearerTokenProvider(auth, { async getToken() { return { token: "expired", expiresOnTimestamp: 0 }; } }), /acquisition failed/);
});
test("invalid/ignored identity options and Anthropic wireApi are rejected", () => {
  assert.throws(() => providerSchema.parse({ type: "anthropic", wireApi: "responses" }));
  assert.throws(() => providerSchema.parse({ type: "openai", auth: { mode: "entra", credential: "default" } }));
  assert.throws(() => providerSchema.parse({ type: "openai", auth: { mode: "entra", credential: "workload-identity" } }));
});
test("quickstart and judge share explicit identity/protocol flags", () => {
  const args = ["--provider", "openai", "--model", "custom", "--auth", "entra", "--credential", "azure-cli", "--wire-api", "responses"];
  assert.equal(parseQuickstartOptions([...args, "--task", "custom task"]).auth?.mode, "entra");
  assert.equal(parseEvaluationOptions(args).wireApi, "responses");
  assert.throws(() => parseQuickstartOptions([...args, "--task", "task", "--auth", "key", "--client-id", "bad"]));
});
