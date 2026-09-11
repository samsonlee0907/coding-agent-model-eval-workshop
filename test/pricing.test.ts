import assert from "node:assert/strict";
import test from "node:test";
import { refreshPricingSnapshot } from "../src/pricing.js";
import type { BenchmarkRun, Metric } from "../src/types.js";

const metric = (value: number): Metric<number> => ({ status: "available", value });
const claudeRun = (): BenchmarkRun => ({
  runId: "claude-run",
  contract: { contractVersion: 1, candidate: { provider: "anthropic", model: "claude-sonnet-5", deployment: "sonnet" },
    task: { id: "task", prompt: "", repository: { commitSha: "sha", containerFingerprint: "env" }, validationCommand: "npm test" },
    execution: { instructions: "", tools: [], permissionMode: "approve-all", concurrency: 1, retries: 0, sessionTimeoutMs: 1, streaming: true, cachePolicy: "default", reasoningEffort: "high" },
    runtime: { sdkVersion: "sdk", cliVersion: "cli", nodeVersion: "node" } },
  contractHash: "hash", sessionId: null, startedAt: "", completedAt: "",
  artifacts: { directory: "", rawEvents: "", normalizedEvents: "", diagnostics: "", report: "" },
  diagnostics: { schemaVersion: 1, runtime: { sdkVersion: "sdk", cliVersion: "cli", nodeVersion: "node" }, selectedModel: "claude-sonnet-5", configuredToolFilters: [], configurationMessages: [], providerFailure: { httpStatus: null, signature: null, message: null } },
  modelCalls: [], toolCalls: [], usageMetrics: null, validation: null,
  metrics: { e2eMs: metric(1), timeToFirstToolCallMs: metric(1), timeToFirstEditMs: metric(1), timeToGreenTestMs: metric(1), timeToFirstTokenMs: metric(1), timePerOutputTokenMs: metric(1), inputTokens: metric(1), cacheReadTokens: metric(0), cacheWriteTokens: metric(0), outputTokens: metric(1), cost: metric(0) },
  outcome: { class: "resolved", category: "deterministic-evaluator", detail: "" }, runnerError: null,
});

test("Claude pricing accepts official React comment nodes and captures both write TTLs", async () => {
  const page = '<div class="ApiTab-module__modelCard"><div><h3>Sonnet 5</h3></div><div><p>Input</p><p>$3<!-- --> <!-- -->/ MTok</p></div><div><p>Output</p><p>$15<!-- --> <!-- -->/ MTok</p></div><div><p>Read</p><p>$0.30<!-- --> <!-- -->/ MTok</p></div><div><p>Write</p><p>$3.75<!-- --> <!-- -->/ MTok</p></div></div>';
  const snapshot = await refreshPricingSnapshot([claudeRun()], { fetch: async () => ({ ok: true, status: 200, statusText: "OK", text: async () => page }) });
  const scenarios = snapshot.candidates[0]!.scenarios;
  assert.equal(scenarios.length, 2);
  assert.deepEqual(scenarios.map((scenario) => scenario.cacheTtl), ["5m", "1h"]);
  assert.equal(scenarios[0]!.input?.retailPrice, 3);
  assert.equal(scenarios[0]!.output?.retailPrice, 15);
  assert.equal(scenarios[1]!.cacheWrite?.retailPrice, 6);
});
