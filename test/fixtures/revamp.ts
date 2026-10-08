import { join } from "node:path";
import { immutableContractHash } from "../../src/contract.js";
import { executionProfile } from "../../src/runner.js";
import type { BenchmarkConfig, BenchmarkRun, DerivedMetrics, RunContract, RuntimeIdentity } from "../../src/types.js";

export const fixtureRuntime: RuntimeIdentity = { sdkVersion: "1.0.10-preview.0", cliVersion: "fixture-1", nodeVersion: process.version };
export function fixtureConfig(workspacePath = "workspace", taskId = "custom-task", model = "candidate-a"): BenchmarkConfig {
  return {
    contract: {
      task: { id: taskId, version: "1", title: taskId, taskType: "user-defined", prompt: "Return a valid custom artifact.",
        repository: { commitSha: "fixture-baseline", containerFingerprint: "fixture-runtime" }, validationCommand: "node --version" },
      candidate: { provider: "openai", model, deployment: model }, foundryProvider: { type: "openai", wireApi: "responses" },
      execution: { instructions: "Follow the task contract.", tools: ["read", "edit", "shell"], permissionMode: "approve-all",
        concurrency: 1, retries: 0, sessionTimeoutMs: 5000, streaming: true, cachePolicy: "default", reasoningEffort: "high" },
      runtime: { ...fixtureRuntime },
    },
    workspacePath, rounds: [],
  };
}
export function fixtureRun(id: string, config = fixtureConfig(), verdict: "pass" | "fail" | "ungraded" = "pass"): BenchmarkRun {
  const contract: RunContract = {
    contractVersion: 2, task: config.contract.task, candidate: config.contract.candidate, execution: config.contract.execution,
    runtime: { ...fixtureRuntime, ...config.contract.runtime }, rounds: config.rounds, executionProfile: executionProfile(config),
    foundryProvider: { type: config.contract.foundryProvider.type, requestAdaptation: "openai-null-refusal-sanitizer",
      endpointFingerprint: "a".repeat(64), wireApi: "responses", auth: { mode: "key" } },
  };
  const available = (value: number) => ({ status: "available" as const, value });
  const metrics: DerivedMetrics = {
    e2eMs: available(1250), timeToFirstToolCallMs: available(200), timeToFirstEditMs: available(400), timeToGreenTestMs: available(1200),
    timeToFirstTokenMs: available(50), timePerOutputTokenMs: available(1), inputTokens: available(100), outputTokens: available(30),
    cacheReadTokens: available(0), cacheWriteTokens: available(0), cost: { status: "unavailable", value: null, reason: "No billed-cost evidence." },
  };
  const directory = join(config.artifactsDirectory ?? "missing-artifacts", id);
  const date = "2026-10-08T00:00:00.000Z";
  return {
    runId: id, contract, contractHash: immutableContractHash(contract), sessionId: null, startedAt: date, completedAt: date,
    artifacts: { directory, rawEvents: join(directory, "raw-events.ndjson"), normalizedEvents: join(directory, "normalized-events.ndjson"),
      diagnostics: join(directory, "diagnostics.json"), report: join(directory, "report.md"), workspace: config.workspacePath },
    diagnostics: { schemaVersion: 1, runtime: fixtureRuntime, selectedModel: config.contract.candidate.model,
      configuredToolFilters: [], configurationMessages: [], providerFailure: { httpStatus: null, signature: null, message: null } },
    modelCalls: [], toolCalls: [], usageMetrics: null, metrics, runnerError: null, executionStatus: "completed",
    requestAccounting: { physicalRequests: 1, reservedTokens: 200, ambiguousRequests: 0, rejectedRequests: 0 },
    validation: { command: "fixture-validator", exitCode: 0, timedOut: false, errorMessage: null, startedAt: date, completedAt: date, durationMs: 10, stdout: "", stderr: "" },
    outcome: { class: verdict === "fail" ? "unresolved" : "resolved", category: "deterministic-evaluator", detail: "fixture" },
    ...(verdict === "ungraded" ? {} : { conformance: {
      available: true, description: null, startedAt: date, completedAt: date, durationMs: 10, setup: null,
      conformant: verdict === "pass", totals: { total: 1, passed: verdict === "pass" ? 1 : 0, weak: 0, failed: verdict === "fail" ? 1 : 0, errored: 0 },
      checks: [{ id: "public-requirement", description: "Public acceptance", command: "private-check", severity: "required",
        status: verdict, exitCode: verdict === "pass" ? 0 : 1, timedOut: false, durationMs: 10, stdout: "", stderr: "", errorMessage: null }],
    } }),
  };
}
