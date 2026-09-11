import assert from "node:assert/strict";
import test from "node:test";
import { immutableContractHash } from "../src/contract.js";
import { deriveMetrics, extractModelCalls } from "../src/metrics.js";
import { renderModelSelectionReport } from "../src/portfolio.js";
import type { BenchmarkRun, DerivedMetrics, RunContract } from "../src/types.js";
import { streamingEvents } from "./fixtures/events.js";

function run(id: string, model: string, cost: number | null): BenchmarkRun {
  const contract: RunContract = {
    contractVersion: 2,
    task: {
      id: "shared-task",
      prompt: "Implement the task.",
      repository: { commitSha: "pinned", containerFingerprint: "image:v1" },
      validationCommand: "npm test",
    },
    candidate: { provider: "foundry", model, deployment: "shared-region" },
    execution: {
      instructions: "Work only in the workspace.",
      tools: ["read", "edit", "shell"],
      permissionMode: "approve-all",
      concurrency: 1,
      retries: 0,
      sessionTimeoutMs: 60_000,
      streaming: true,
      cachePolicy: "default",
      reasoningEffort: "high",
    },
    rounds: [{ prompt: "Review and repair." }],
    runtime: { sdkVersion: "1", cliVersion: "1", nodeVersion: "v22" },
  };
  const modelCalls = extractModelCalls(streamingEvents);
  const metrics: DerivedMetrics = {
    ...deriveMetrics(streamingEvents, modelCalls),
    cost: cost === null
      ? { status: "unavailable", value: null, reason: "Provider did not report cost." }
      : { status: "available", value: cost, source: "provider" },
  };
  return {
    runId: id,
    contract,
    contractHash: immutableContractHash(contract),
    sessionId: null,
    startedAt: "2026-08-19T00:00:00.000Z",
    completedAt: "2026-08-19T00:00:05.000Z",
    artifacts: {
      directory: "artifacts",
      rawEvents: "raw.ndjson",
      normalizedEvents: "missing.ndjson",
      diagnostics: "diagnostics.json",
      report: "report.md",
    },
    diagnostics: {
      schemaVersion: 1,
      runtime: contract.runtime,
      selectedModel: model,
      configuredToolFilters: [],
      configurationMessages: [],
      providerFailure: { httpStatus: null, signature: null, message: null },
    },
    modelCalls,
    toolCalls: [],
    usageMetrics: null,
    validation: {
      command: "npm test",
      startedAt: "2026-08-19T00:00:04.000Z",
      completedAt: "2026-08-19T00:00:05.000Z",
      durationMs: 1_000,
      exitCode: 0,
      timedOut: false,
      errorMessage: null,
      stdout: "",
      stderr: "",
    },
    metrics,
    outcome: { class: "resolved", category: "deterministic-evaluator", detail: "passed" },
    runnerError: null,
  };
}

test("portfolio requires reported non-zero cost for every candidate's resolved samples", () => {
  const runs = [
    ...["one", "two", "three"].map((id) => run(`gpt-${id}`, "gpt", 0.5)),
    ...["one", "two", "three"].map((id) => run(`claude-${id}`, "claude", null)),
  ];

  const report = renderModelSelectionReport(runs);
  assert.match(report, /Decision status:\*\* No-go/);
  assert.match(report, /\| Monetary cost evidence \| Missing \|/);
});

test("portfolio rejects a cohort with runtime identity drift", () => {
  const runs = [
    ...["one", "two", "three"].map((id) => run(`gpt-${id}`, "gpt", 0.5)),
    ...["one", "two", "three"].map((id) => run(`claude-${id}`, "claude", 0.5)),
  ];
  runs[1]!.contract.runtime.cliVersion = "2";

  const report = renderModelSelectionReport(runs);
  assert.match(report, /\| Strictly comparable baseline \| Fail \| 2 baseline\/task\/environment variants are present\. \|/);
});

test("portfolio rejects round prompt, count, and mode drift", () => {
  const variants: Array<(run: BenchmarkRun) => void> = [
    (run) => { run.contract.rounds![0]!.prompt = "Different review request."; },
    (run) => { run.contract.rounds!.push({ prompt: "Additional follow-up." }); },
    (run) => { run.contract.rounds![0]!.mode = "immediate"; },
  ];
  for (const change of variants) {
    const runs = [run("gpt-1", "gpt", 0.5), run("claude-1", "claude", 0.5)];
    change(runs[1]!);
    const report = renderModelSelectionReport(runs);
    assert.match(report, /\| Strictly comparable baseline \| Fail \| 2 baseline\/task\/environment variants are present\. \|/);
  }
});

test("portfolio rejects a version-1 cohort with unrecorded rounds", () => {
  const runs = [run("gpt-1", "gpt", 0.5), run("claude-1", "claude", 0.5)];
  runs[1]!.contract = { ...runs[1]!.contract, contractVersion: 1, rounds: undefined };
  const report = renderModelSelectionReport(runs);
  assert.match(report, /\| Strictly comparable baseline \| Fail \| Unknown: one or more runs did not record a version-2 round plan\. \|/);
});

test("portfolio accepts an identical version-2 cohort", () => {
  const runs = [run("gpt-1", "gpt", 0.5), run("claude-1", "claude", 0.5)];
  const report = renderModelSelectionReport(runs);
  assert.match(report, /\| Strictly comparable baseline \| Pass \| 1 baseline\/task\/environment variants are present\. \|/);
});
