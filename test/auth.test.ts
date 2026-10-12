import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { bearerTokenProvider, createCredential, foundryScope, providerSchema } from "../src/auth.js";
import { cliCredentialInternals } from "../node_modules/@azure/identity/dist/esm/credentials/azureCliCredential.js";
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

test("Azure CLI subscription selector is passed without an incompatible tenant flag or default-context mutation", async () => {
  const tenantId = "11111111-2222-4333-8444-555555555555", subscriptionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const acquisition = mock.method(cliCredentialInternals, "getAzureCliAccessToken", async (resource: string, tenant: string, subscription: string) => {
    assert.equal(resource, "https://ai.azure.com"); assert.equal(tenant, undefined); assert.equal(subscription, subscriptionId);
    return { stdout: JSON.stringify({ accessToken: "fixture-only-token", expiresOn: "2099-01-01 00:00:00.000000" }), stderr: "", error: null };
  });
  try {
    const credential = createCredential({ mode: "entra", credential: "azure-cli", subscriptionId });
    assert.equal((await credential.getToken(foundryScope, { abortSignal: AbortSignal.timeout(5000) }))?.token, "fixture-only-token");
    assert.equal(acquisition.mock.callCount(), 1);
  } finally { acquisition.mock.restore(); }
  const incompatible = { mode: "entra" as const, credential: "azure-cli" as const, tenantId, subscriptionId };
  assert.throws(() => createCredential(incompatible), /only one of tenantId or subscriptionId/);
  assert.throws(() => providerSchema.parse({ type: "openai", auth: incompatible }), /only one of tenantId or subscriptionId/);
  const flags = ["--provider", "openai", "--model", "fixture", "--auth", "entra", "--credential", "azure-cli",
    "--tenant-id", tenantId, "--subscription-id", subscriptionId];
  assert.throws(() => parseQuickstartOptions([...flags, "--task", "fixture"]), /only one of tenantId or subscriptionId/);
  assert.throws(() => parseEvaluationOptions(flags), /only one of tenantId or subscriptionId/);
  assert.throws(() => providerSchema.parse({ type: "openai", auth: { mode: "entra", credential: "managed-identity", subscriptionId } }));
  const auth = { mode: "entra" as const, credential: "azure-cli" as const, subscriptionId };
  await assert.rejects(bearerTokenProvider(auth, { async getToken() { throw new Error("AADSTS90072 account private@example.test secret=PRIVATE"); } }),
    (error: Error) => /AADSTS90072.*not inference RBAC/.test(error.message) && !/private@|PRIVATE/.test(error.message));
});
