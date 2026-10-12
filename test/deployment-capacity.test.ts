import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertCapacityPolicy, capacityIdentity } from "../src/deployment-capacity.js";
import { providerSchema } from "../src/auth.js";
import { createFoundryProviderIdentity, runBenchmark } from "../src/runner.js";
import { prepareCampaign } from "../src/campaign.js";
import { fixtureConfig, fixtureRuntime, fixtureRun } from "./fixtures/revamp.js";
import { compareRunContracts, comparableBaselineSignature } from "../src/contract.js";
import { FoundryJudgeInvoker } from "../src/evaluator.js";

function config() {
  const result = fixtureConfig();
  result.contract.foundryProvider.capacity = {
    source: "administrator-declared", observedAt: "2026-10-13T00:00:00Z",
    endpoint: "https://fixture.services.ai.azure.com", deployment: result.contract.candidate.model, wireApi: "responses",
    requestsPerMinute: 12, tokensPerMinute: 12000,
  };
  result.requestBounds = { maxRequests: 10, maxRequestBytes: 1048576, maxTokens: 100000, maxOutputTokens: 2000,
    deadlineMs: 900000, requestsPerMinute: 1, tokensPerMinute: 8000 };
  return result;
}

test("capacity binding rejects endpoint/deployment/wire and over-allocation mismatches without credentials or dispatch", async () => {
  const value = config();
  providerSchema.parse(value.contract.foundryProvider);
  assert.doesNotThrow(() => assertCapacityPolicy(value, value.contract.foundryProvider.capacity!.endpoint));
  assert.throws(() => assertCapacityPolicy(value, "https://other.services.ai.azure.com"), /endpoint\/deployment\/wire/);
  value.contract.candidate.model = "other";
  assert.throws(() => assertCapacityPolicy(value), /observation does not match/);
  value.contract.candidate.model = "candidate-a";
  value.contract.foundryProvider.wireApi = "completions";
  assert.throws(() => assertCapacityPolicy(value), /observation does not match/);
  value.contract.foundryProvider.wireApi = "responses";
  value.requestBounds!.requestsPerMinute = 13;
  assert.throws(() => assertCapacityPolicy(value), /13 RPM.*exceeds/);
  await assert.rejects(() => runBenchmark(value), /exceeds|observation does not match/);
  const judge = new FoundryJudgeInvoker();
  await assert.rejects(() => judge.judge("Public quota fixture", {
    provider: value.contract.foundryProvider, model: "candidate-a", reasoningEffort: "high",
    timeoutMs: 5000, requestBounds: value.requestBounds,
  }), /exceeds|observation does not match/);
  assert.equal(judge.requestAccounting, undefined);
  value.requestBounds!.requestsPerMinute = 1; value.requestBounds!.tokensPerMinute = 12001;
  assert.throws(() => assertCapacityPolicy(value), /12001 TPM.*exceeds/);
  value.requestBounds = undefined;
  assert.throws(() => assertCapacityPolicy(value), /finite requestBounds/);
});

test("capacity changes are comparison drift but observation timestamps are provenance only", () => {
  const left = fixtureRun("left").contract, right = structuredClone(left);
  left.foundryProvider!.capacity = capacityIdentity(config().contract.foundryProvider);
  right.foundryProvider!.capacity = structuredClone(left.foundryProvider!.capacity);
  right.foundryProvider!.capacity!.observedAt = "2026-10-14T00:00:00Z";
  assert.equal(compareRunContracts(left, right).strictlyComparable, true);
  assert.equal(comparableBaselineSignature(left), comparableBaselineSignature(right));
  right.foundryProvider!.capacity!.tokensPerMinute = 13000;
  assert.equal(compareRunContracts(left, right).strictlyComparable, false);
  assert.notEqual(comparableBaselineSignature(left), comparableBaselineSignature(right));
});
test("capacity identity retains observation and protocol but never publishes its resource endpoint", () => {
  const value = config();
  const identity = capacityIdentity(value.contract.foundryProvider)!;
  assert.match(identity.endpointFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(identity.deployment, "candidate-a"); assert.equal(identity.tokensPerMinute, 12000);
  assert.equal(identity.wireApi, "responses"); assert.equal(identity.source, "administrator-declared");
  const provider = createFoundryProviderIdentity(value.contract.foundryProvider,
    { FOUNDRY_ENDPOINT: value.contract.foundryProvider.capacity!.endpoint });
  assert.deepEqual(provider.capacity, identity);
  assert.equal(provider.endpointFingerprint, identity.endpointFingerprint);
  assert.doesNotMatch(JSON.stringify(provider), /https:|fixture\.services/);
});

test("offline campaign preparation checks each candidate capacity before creating state and pins valid observations", () => {
  const root = mkdtempSync(join(tmpdir(), "bt-capacity-prepare-"));
  try {
    const spec = JSON.parse(readFileSync(resolve("examples", "custom-campaign", "campaign.json"), "utf8"));
    spec.candidates = [spec.candidates[0]]; spec.tasks = [spec.tasks[0]];
    spec.tasks[0].config = resolve("examples", "custom-campaign", "text-task.json");
    spec.tasks[0].evaluator = resolve("examples", "custom-campaign", "text-evaluator.json");
    spec.candidates[0].foundryProvider.capacity = { ...config().contract.foundryProvider.capacity,
      deployment: spec.candidates[0].candidate.model };
    const path = join(root, "spec.json"), directory = join(root, "state");
    writeFileSync(path, JSON.stringify(spec));
    assert.throws(() => prepareCampaign(path, directory, fixtureRuntime), /exceeds/);
    assert.equal(existsSync(directory), false);
    spec.requestBounds.requestsPerMinute = 1; spec.requestBounds.tokensPerMinute = 8000;
    writeFileSync(path, JSON.stringify(spec));
    const prepared = prepareCampaign(path, directory, fixtureRuntime);
    assert.deepEqual(prepared.spec.candidates[0].foundryProvider.capacity, spec.candidates[0].foundryProvider.capacity);
    assert.equal(prepared.spec.requestBounds.tokensPerMinute, 8000);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
