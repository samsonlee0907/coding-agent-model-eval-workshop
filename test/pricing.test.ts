import assert from "node:assert/strict";
import test from "node:test";
import { refreshPricingSnapshot, estimateRunPriceUsd, azureOpenAiPricingUrl, anthropicClaudePricingUrl } from "../src/pricing.js";
import type { BenchmarkRun, Metric } from "../src/types.js";
import { providerTerminal } from "../src/provider-stream.js";

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

const lunaRun = (): BenchmarkRun => {
  const run = claudeRun();
  run.runId = "luna-run";
  run.contract.candidate = { provider: "openai", model: "gpt-6-luna", deployment: "local-byok" };
  run.diagnostics.selectedModel = "gpt-6-luna";
  return run;
};

const haikuRun = (): BenchmarkRun => {
  const run = claudeRun();
  run.runId = "haiku-run";
  run.contract.candidate = { provider: "anthropic", model: "claude-haiku-4-5", deployment: "local-byok" };
  run.diagnostics.selectedModel = "claude-haiku-4-5";
  return run;
};

test("Claude pricing accepts official React comment nodes and captures both write TTLs", async () => {
  const page = '<div class="ApiTab-module__modelCard"><div><h3>Sonnet 5</h3></div><div><p>Input</p><p>$3<!-- --> <!-- -->/ MTok</p></div><div><p>Output</p><p>$15<!-- --> <!-- -->/ MTok</p></div><div><p>Read</p><p>$0.30<!-- --> <!-- -->/ MTok</p></div><div><p>Write</p><p>$3.75<!-- --> <!-- -->/ MTok</p></div></div>';
  const snapshot = await refreshPricingSnapshot([claudeRun()], { fetch: async () => ({ ok: true, status: 200, statusText: "OK", text: async () => page }) });
  const scenarios = snapshot.candidates[0]!.scenarios;
  assert.equal(scenarios.length, 2);
  assert.deepEqual(scenarios.map((scenario) => scenario.cacheTtl), ["5m", "1h"]);
  assert.equal(scenarios[0]!.input?.retailPrice, 3);
  assert.equal(scenarios[0]!.output?.retailPrice, 15);
  assert.equal(scenarios[1]!.cacheWrite?.retailPrice, 6);
  const run = claudeRun(), scenario = scenarios[0].id;
  run.requestAccounting = { physicalRequests: 1, reservedTokens: 1000, ambiguousRequests: 1, rejectedRequests: 0 };
  assert.match(estimateRunPriceUsd(run, snapshot, scenario, "sdk-inclusive").unavailableReason!, /historical usage cannot be reconstructed/);
  const terminal = providerTerminal({ type: "response.incomplete", response: { status: "incomplete", output: [],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }, true)!;
  run.requestAccounting.providerTerminals = [{ request: 1, terminal }];
  assert.notEqual(estimateRunPriceUsd(run, snapshot, scenario, "sdk-inclusive").totalUsd, null);
  run.requestAccounting.physicalRequests = 2;
  assert.equal(estimateRunPriceUsd(run, snapshot, scenario, "sdk-inclusive").totalUsd, null);
  assert.match(estimateRunPriceUsd(run, snapshot, scenario, "sdk-inclusive").unavailableReason!, /known subtotals cannot price unknown spend/);
});

test("current Luna and Haiku labels match conservatively without overrides and inexact overrides name exact rows", async () => {
  const azure = `<table><tr><td>GPT-6 Luna (short context) Global</td><td>
    Input: <span data-amount='{"global":0.1}'></span><br>
    Cached Input: <span data-amount='{"global":0.01}'></span><br>
    Cache Write: <span data-amount='{"global":0.125}'></span><br>
    Output: <span data-amount='{"global":0.5}'></span>
  </td></tr><tr><td>GPT-6 Luna (long context) Data Zone</td><td>
    Input: <span data-amount='{"regional":{"us-east":0.22}}'></span><br>
    Cached Input: <span data-amount='{"regional":{"us-east":0.022}}'></span><br>
    Cache Write: <span data-amount='{"regional":{"us-east":0.275}}'></span><br>
    Output: <span data-amount='{"regional":{"us-east":1.1}}'></span>
  </td></tr></table>`;
  const claude = '<div class="ApiTab-module-scss-module__modelCard"><h3>Haiku 4.5</h3><p>Input $1 / MTok</p><p>Output $5 / MTok</p><p>Read $0.10 / MTok</p><p>Write $1.25 / MTok</p></div>';
  const fetch = async (url: string) => ({
    ok: true, status: 200, statusText: "OK",
    text: async () => url === azureOpenAiPricingUrl ? azure : url === anthropicClaudePricingUrl ? claude : "",
  });
  const automatic = await refreshPricingSnapshot([lunaRun(), haikuRun()], { fetch });
  assert.deepEqual(automatic.candidates.map((candidate) => candidate.scenarios.length), [2, 2]);
  assert.deepEqual(automatic.candidates[0]!.scenarios.map((scenario) => scenario.officialModel),
    ["GPT-6 Luna (short context) Global", "GPT-6 Luna (long context) Data Zone"]);
  assert.ok(automatic.candidates[1]!.scenarios.every((scenario) => scenario.officialModel === "Haiku 4.5"));

  const inexact = await refreshPricingSnapshot([lunaRun(), haikuRun()], {
    fetch, modelOverrides: { "gpt-6-luna": "GPT-6 Luna", "claude-haiku-4-5": "Claude Haiku 4.5" },
  });
  assert.ok(inexact.candidates.every((candidate) => candidate.scenarios.length === 0));
  assert.match(inexact.candidates[0]!.unavailableReason ?? "", /automatic matches:.*GPT-6 Luna \(short context\) Global.*Remove the override/);
  assert.match(inexact.candidates[1]!.unavailableReason ?? "", /automatic matches:.*Haiku 4\.5.*Remove the override/);

  const exact = await refreshPricingSnapshot([lunaRun(), haikuRun()], {
    fetch, modelOverrides: { "gpt-6-luna": "GPT-6 Luna (short context) Global", "claude-haiku-4-5": "Haiku 4.5" },
  });
  assert.deepEqual(exact.candidates.map((candidate) => candidate.scenarios.length), [1, 2]);
});
