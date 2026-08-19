import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { BenchmarkRun, Metric } from "./types.js";

const minimumComparableRepeats = 3;

export function loadBenchmarkRuns(directory: string): BenchmarkRun[] {
  return walk(directory)
    .filter((path) => path.endsWith("run.json"))
    .map((path) => JSON.parse(readFileSync(path, "utf8")) as BenchmarkRun);
}

export function writeModelSelectionReport(runs: readonly BenchmarkRun[], outputPath: string): void {
  writeFileSync(outputPath, renderModelSelectionReport(runs), "utf8");
}

export function renderModelSelectionReport(runs: readonly BenchmarkRun[]): string {
  if (runs.length === 0) {
    throw new RangeError("A model selection report requires at least one completed run.");
  }
  const candidates = [...groupByCandidate(runs).values()];
  const comparableBaselines = new Set(runs.map(baselineSignature));
  const hasStrictBaseline = comparableBaselines.size === 1;
  const allCandidatesHaveResolvedRun = candidates.every((candidate) => candidate.runs.some((run) => run.outcome.class === "resolved"));
  const enoughComparableRepeats = hasStrictBaseline && candidates.every(
    (candidate) => candidate.runs.filter((run) => run.outcome.class === "resolved").length >= minimumComparableRepeats,
  );
  const costAvailableForEveryCandidate = candidates.every(hasCostEvidenceForResolvedRuns);
  const productionDecisionReady = allCandidatesHaveResolvedRun && enoughComparableRepeats && costAvailableForEveryCandidate;

  return [
    "# Model-selection evidence report",
    "",
    `**Completed runs:** ${runs.length}  `,
    `**Candidates:** ${candidates.length}  `,
    `**Decision status:** ${productionDecisionReady ? "Candidate selection evidence is sufficient" : "No-go: collect more evidence before selecting a production route"}`,
    "",
    "## Executive decision view",
    "",
    "| Gate | Status | Evidence |",
    "|---|---|---|",
    `| Deterministic correctness | ${allCandidatesHaveResolvedRun ? "Pass, provisionally" : "Fail"} | Every candidate has at least one resolved run only when the gate passes. |`,
    `| Strictly comparable baseline | ${hasStrictBaseline ? "Pass" : "Fail"} | ${comparableBaselines.size} baseline/task/environment variants are present. |`,
    `| Repeatability | ${enoughComparableRepeats ? "Pass" : "Fail"} | Require at least ${minimumComparableRepeats} resolved repetitions per candidate from one pinned baseline. |`,
    `| Monetary cost evidence | ${costAvailableForEveryCandidate ? "Present" : "Missing"} | Every resolved sample for every candidate must report a non-zero provider cost before cost-per-resolved-task is valid. |`,
    "| Code-quality breadth | Missing | Deterministic build/test is captured; coverage, lint, security, accessibility, and human-review evidence are not. |",
    "",
    "## Candidate reliability and outcome history",
    "",
    "| Candidate | Runs | Resolved | Unresolved | Harness | Rate limit | Timeout | Tool/container | Empty patch |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...candidates.map(renderOutcomeRow),
    "",
    "Failures remain included here. A candidate with one successful run but recurring harness or evaluator failures is not production-ready.",
    "",
    "## Observed efficiency on resolved runs",
    "",
    "| Candidate | Resolved samples | Median E2E | Median input + output tokens | Median turns | Median tool calls | Median TTFT | Median validation time |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...candidates.map(renderEfficiencyRow),
    "",
    "Medians with one sample are single observed values, not performance estimates. Cached-token pricing is provider-specific and must not be converted to money without a versioned pricing source.",
    "",
    "## Deterministic quality evidence",
    "",
    "| Candidate | Resolved validations | Validator commands observed | Quality statement supported today |",
    "|---|---:|---|---|",
    ...candidates.map(renderQualityRow),
    "",
    "The current evidence proves only that the recorded deterministic validators passed. It does not establish maintainability, security, accessibility, coverage, or subjective code quality.",
    "",
    "## Operational and integration risks",
    "",
    ...renderFailureEvidence(candidates),
    "",
    "## What to capture next for a routing decision",
    "",
    "1. Run each candidate at least three times from the exact same committed starter baseline, environment fingerprint, instructions, tool profile, timeout, retry policy, and validation command.",
    "2. Add provider price version, region, deployment/SKU, currency, and cache-pricing policy; calculate cost per resolved task only after those are captured.",
    "3. Add deterministic quality gates appropriate to the task: lint/typecheck, coverage threshold, accessibility checks, security/static analysis, and repository-specific acceptance tests.",
    "4. Record p50/p95 E2E, TTFT, validation duration, input/output/cache tokens, and failure rate across repetitions. Keep harness/provider failures in the denominator.",
    "5. Capture deployment availability, quota/rate-limit events, data residency, endpoint protocol, fallback candidate, and rollback threshold before enabling routing.",
    "6. Add a human or rubric-based review only as a secondary signal; do not replace deterministic code validation with an LLM judge.",
    "",
    "## Comparability and artifact lineage",
    "",
    `Baseline/task/environment variants observed: ${comparableBaselines.size}.`,
    "",
    "| Candidate | Task ID | Baseline commit | Environment fingerprint | Reasoning effort | Wire adaptation |",
    "|---|---|---|---|---|---|",
    ...runs.map((run) => `| ${candidateLabel(run)} | ${escapeCell(run.contract.task.id)} | \`${run.contract.task.repository.commitSha}\` | \`${run.contract.task.repository.containerFingerprint}\` | ${run.contract.execution.reasoningEffort ?? "not recorded"} | ${run.contract.foundryProvider?.requestAdaptation ?? "legacy/unknown"} |`),
    "",
    "Raw event, normalized event, diagnostics, per-run report, and run-contract paths remain in each run's `run.json` artifact.",
    "",
  ].join("\n");
}

function groupByCandidate(runs: readonly BenchmarkRun[]): Map<string, CandidateSummary> {
  const groups = new Map<string, CandidateSummary>();
  for (const run of runs) {
    const key = candidateLabel(run);
    const group = groups.get(key) ?? { label: key, runs: [] };
    group.runs.push(run);
    groups.set(key, group);
  }
  return groups;
}

function renderOutcomeRow(candidate: CandidateSummary): string {
  const count = (outcome: BenchmarkRun["outcome"]["class"]) => candidate.runs.filter((run) => run.outcome.class === outcome).length;
  return `| ${candidate.label} | ${candidate.runs.length} | ${count("resolved")} | ${count("unresolved")} | ${count("harness_failure")} | ${count("rate_limit")} | ${count("timeout")} | ${count("tool_container_failure")} | ${count("empty_patch")} |`;
}

function hasCostEvidenceForResolvedRuns(candidate: CandidateSummary): boolean {
  const resolved = candidate.runs.filter((run) => run.outcome.class === "resolved");
  return resolved.length > 0 && resolved.every((run) => {
    const cost = metricValue(run.metrics.cost);
    return cost !== null && cost > 0;
  });
}

function renderEfficiencyRow(candidate: CandidateSummary): string {
  const resolved = candidate.runs.filter((run) => run.outcome.class === "resolved");
  const values = <T>(selector: (run: BenchmarkRun) => T | null): T[] => resolved.flatMap((run) => {
    const value = selector(run);
    return value === null ? [] : [value];
  });
  const turns = values((run) => countTurns(run));
  const tokens = values((run) => {
    const input = metricValue(run.metrics.inputTokens);
    const output = metricValue(run.metrics.outputTokens);
    return input === null || output === null ? null : input + output;
  });
  return `| ${candidate.label} | ${resolved.length} | ${formatMs(median(values((run) => metricValue(run.metrics.e2eMs))))} | ${formatNumber(median(tokens))} | ${formatNumber(median(turns))} | ${formatNumber(median(values((run) => run.toolCalls.length)))} | ${formatMs(median(values((run) => metricValue(run.metrics.timeToFirstTokenMs))))} | ${formatMs(median(values((run) => run.validation?.durationMs ?? null)))} |`;
}

function renderQualityRow(candidate: CandidateSummary): string {
  const resolved = candidate.runs.filter((run) => run.outcome.class === "resolved");
  const commands = [...new Set(resolved.flatMap((run) => run.validation ? [run.validation.command] : []))];
  return `| ${candidate.label} | ${resolved.length}/${candidate.runs.length} | ${commands.length === 0 ? "Unavailable" : commands.map((command) => `\`${escapeCell(command)}\``).join("<br>")} | ${resolved.length > 0 ? "Recorded deterministic validation passed." : "No resolved deterministic validation."} |`;
}

function renderFailureEvidence(candidates: readonly CandidateSummary[]): string[] {
  const entries = candidates.flatMap((candidate) => candidate.runs
    .filter((run) => run.outcome.class !== "resolved")
    .map((run) => `- **${candidate.label} — ${run.outcome.class}:** ${escapeCell(redactUrls(run.runnerError ?? run.outcome.detail))}`));
  return entries.length === 0 ? ["No non-resolved outcomes were recorded."] : entries;
}

function countTurns(run: BenchmarkRun): number | null {
  try {
    return readFileSync(run.artifacts.normalizedEvents, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { eventType?: unknown })
      .filter((event) => event.eventType === "assistant.turn_start").length;
  } catch {
    return null;
  }
}

function baselineSignature(run: BenchmarkRun): string {
  return JSON.stringify({
    task: run.contract.task,
    instructions: run.contract.execution.instructions,
    tools: run.contract.execution.tools,
    permissionMode: run.contract.execution.permissionMode,
    retries: run.contract.execution.retries,
    timeout: run.contract.execution.sessionTimeoutMs,
    cachePolicy: run.contract.execution.cachePolicy,
    reasoningEffort: run.contract.execution.reasoningEffort ?? null,
    adaptation: run.contract.foundryProvider?.requestAdaptation ?? "legacy/unknown",
    runtime: run.contract.runtime,
  });
}

function candidateLabel(run: BenchmarkRun): string {
  const candidate = run.contract.candidate;
  return `${candidate.provider}/${candidate.model}${candidate.deployment ? `/${candidate.deployment}` : ""}`;
}

function metricValue(metric: Metric<number>): number | null {
  return metric.status === "available" ? metric.value : null;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[midpoint - 1]! + sorted[midpoint]!) / 2 : sorted[midpoint]!;
}

function formatMs(value: number | null): string {
  if (value === null) {
    return "Unavailable";
  }
  return value >= 60_000 ? `${(value / 60_000).toFixed(2)}m` : `${value.toFixed(0)}ms`;
}

function formatNumber(value: number | null): string {
  return value === null ? "Unavailable" : Math.round(value).toLocaleString("en-US");
}

function redactUrls(value: string): string {
  return value.replace(/https?:\/\/[^\s)"']+/gi, "<redacted-provider-url>");
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function walk(directory: string): string[] {
  const resolved = resolve(directory);
  return readdirSync(resolved).flatMap((entry) => {
    const path = join(resolved, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

interface CandidateSummary {
  label: string;
  runs: BenchmarkRun[];
}
