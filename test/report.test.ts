import assert from "node:assert/strict";
import test from "node:test";
import { immutableContractHash } from "../src/contract.js";
import { deriveMetrics, extractModelCalls, extractToolCalls } from "../src/metrics.js";
import { renderPairedComparison, renderRunReport } from "../src/report.js";
import type { BenchmarkRun, RunContract } from "../src/types.js";
import { streamingEvents } from "./fixtures/events.js";

const contract: RunContract = {
  contractVersion: 1,
  task: {
    id: "task-1",
    prompt: "Fix it.",
    repository: { commitSha: "abc", containerFingerprint: "image:1" },
    validationCommand: "npm test",
  },
  candidate: { provider: "github", model: "gpt-test" },
  execution: {
    instructions: "Be careful.",
    tools: ["read", "edit"],
    permissionMode: "approve-all",
    concurrency: 1,
    retries: 0,
    sessionTimeoutMs: 60_000,
    streaming: true,
    cachePolicy: "default",
  },
  runtime: { sdkVersion: "1.0.10", cliVersion: "1", nodeVersion: "v22" },
};

function run(outcome: BenchmarkRun["outcome"]): BenchmarkRun {
  const modelCalls = extractModelCalls(streamingEvents);
  return {
    runId: "run-1",
    contract,
    contractHash: immutableContractHash(contract),
    sessionId: "session-1",
    startedAt: "2026-08-18T00:00:00.000Z",
    completedAt: "2026-08-18T00:00:05.000Z",
    artifacts: { directory: "artifacts", rawEvents: "raw.ndjson", normalizedEvents: "normalized.ndjson", report: "report.md" },
    modelCalls,
    toolCalls: extractToolCalls(streamingEvents),
    usageMetrics: null,
    validation: null,
    metrics: deriveMetrics(streamingEvents, modelCalls),
    outcome,
    runnerError: null,
  };
}

test("run report makes unavailable metrics and raw artifact locations visible", () => {
  const report = renderRunReport(run({ class: "resolved", category: "deterministic-evaluator", detail: "passed" }));
  assert.match(report, /Raw SDK envelopes/);
  assert.match(report, /Implementation-phase reporting/);
  assert.match(report, /Unavailable/);
});

test("paired report retains failure outcomes", () => {
  const report = renderPairedComparison(
    run({ class: "resolved", category: "deterministic-evaluator", detail: "passed" }),
    run({ class: "rate_limit", category: "agent-or-infrastructure", detail: "limited" }),
  );
  assert.match(report, /rate_limit/);
  assert.match(report, /Strictly comparable:\*\* Yes/);
});
