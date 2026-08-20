import { writeFileSync } from "node:fs";
import { compareRunContractSet } from "./contract.js";
import type { BenchmarkRun, Metric } from "./types.js";

export function renderRunReport(run: BenchmarkRun): string {
  const rows = [
    ["Outcome", `${run.outcome.class} (${run.outcome.category})`],
    ["E2E", formatMetric(run.metrics.e2eMs)],
    ["TTFT", formatMetric(run.metrics.timeToFirstTokenMs)],
    ["TPOT", formatMetric(run.metrics.timePerOutputTokenMs)],
    ["First tool call", formatMetric(run.metrics.timeToFirstToolCallMs)],
    ["First edit", formatMetric(run.metrics.timeToFirstEditMs)],
    ["Green validation", formatMetric(run.metrics.timeToGreenTestMs)],
    ["Input tokens", formatMetric(run.metrics.inputTokens)],
    ["Output tokens", formatMetric(run.metrics.outputTokens)],
    ["Cache-read tokens", formatMetric(run.metrics.cacheReadTokens)],
    ["Cache-write tokens", formatMetric(run.metrics.cacheWriteTokens)],
    ["Cost multiplier", formatMetric(run.metrics.cost)],
  ];
  return [
    `# Benchmark run ${run.runId}`,
    "",
    `**Candidate:** ${run.contract.candidate.provider} / ${run.contract.candidate.model}${run.contract.candidate.deployment ? ` / ${run.contract.candidate.deployment}` : ""}`,
    `**Contract hash:** \`${run.contractHash}\``,
    `**Session:** ${run.sessionId ?? "Unavailable — session creation failed before an ID was returned."}`,
    `**Wire adaptation:** ${run.contract.foundryProvider?.requestAdaptation ?? "legacy/unknown"}`,
    "",
    "## All-run results",
    "",
    "| Measure | Value |",
    "|---|---|",
    ...rows.map(([label, value]) => `| ${label} | ${value} |`),
    "",
    "## Implementation-phase reporting",
    "",
    `Tool calls observed: ${run.toolCalls.length}; model calls observed: ${run.modelCalls.length}. This section reports every run outcome; it does not exclude failures from implementation-phase summaries.`,
    "",
    "## Validation and root cause",
    "",
    `- **Validation:** ${formatValidation(run)}`,
    ...formatValidationOutput(run.validation),
    `- **Outcome detail:** ${run.outcome.detail}`,
    `- **Runner error:** ${run.runnerError ?? "None"}`,
    `- **Provider failure signature:** ${formatProviderFailure(run)}`,
    `- **SDK configuration messages:** ${formatConfigurationMessages(run)}`,
    "",
    "## Artifacts",
    "",
    `- Raw SDK envelopes (including ephemeral deltas): \`${run.artifacts.rawEvents}\``,
    `- Normalized event stream: \`${run.artifacts.normalizedEvents}\``,
    `- Redacted runtime diagnostics: \`${run.artifacts.diagnostics}\``,
    `- This report: \`${run.artifacts.report}\``,
    "",
    "Raw artifacts can contain prompts, model output, tool arguments, and tool output; store them according to the repository's data-handling policy.",
    "",
  ].join("\n");
}

function formatProviderFailure(run: BenchmarkRun): string {
  const failure = run.diagnostics.providerFailure;
  if (!failure.signature) {
    return "None";
  }
  return `${failure.signature}${failure.httpStatus ? ` (HTTP ${failure.httpStatus})` : ""}`;
}

function formatConfigurationMessages(run: BenchmarkRun): string {
  return run.diagnostics.configurationMessages.length === 0
    ? "None"
    : run.diagnostics.configurationMessages.map((message) => `\`${message}\``).join("; ");
}

export function renderComparison(runs: readonly BenchmarkRun[]): string {
  if (runs.length < 2) {
    throw new RangeError("A candidate comparison requires at least two runs.");
  }
  const comparison = compareRunContractSet(runs.map((run) => run.contract));
  return [
    "# Candidate benchmark comparison",
    "",
    `**Candidates:** ${runs.length}  `,
    `**Strictly comparable:** ${comparison.strictlyComparable ? "Yes" : "No — contract drift detected"}`,
    comparison.drift.length === 0
      ? ""
      : `**Drift:** ${comparison.drift.map((item) => `\`${item.path}\``).join(", ")}`,
    "",
    "| Candidate | Outcome | E2E | Input tokens | Output tokens | Cost |",
    "|---|---|---:|---:|---:|---:|",
    ...runs.map(comparisonRow),
    "",
    "All candidates are included, including unresolved, rate-limited, timeout, tool/container, and harness outcomes.",
    "",
  ].join("\n");
}

export function writeRunReport(run: BenchmarkRun): void {
  writeFileSync(run.artifacts.report, renderRunReport(run), "utf8");
}

function comparisonRow(run: BenchmarkRun): string {
  return `| ${run.contract.candidate.provider}/${run.contract.candidate.model} | ${run.outcome.class} | ${formatMetric(run.metrics.e2eMs)} | ${formatMetric(run.metrics.inputTokens)} | ${formatMetric(run.metrics.outputTokens)} | ${formatMetric(run.metrics.cost)} |`;
}

function formatMetric(metric: Metric<number>): string {
  return metric.status === "available" ? String(metric.value) : `Unavailable — ${metric.reason}`;
}

function formatValidation(run: BenchmarkRun): string {
  if (!run.validation) {
    return "Unavailable — no validation result was recorded.";
  }
  if (run.validation.errorMessage) {
    return `Harness failure: ${run.validation.errorMessage}`;
  }
  return `\`${run.validation.command}\` exited ${run.validation.exitCode} in ${run.validation.durationMs} ms${run.validation.timedOut ? " (timed out)" : ""}.`;
}

function formatValidationOutput(validation: BenchmarkRun["validation"]): string[] {
  if (!validation) {
    return [];
  }
  const sections: string[] = [];
  if (validation.stdout) {
    sections.push("- **Validation stdout:**", "", indentOutput(validation.stdout), "");
  }
  if (validation.stderr) {
    sections.push("- **Validation stderr:**", "", indentOutput(validation.stderr), "");
  }
  return sections;
}

function indentOutput(output: string): string {
  return output.trimEnd().split(/\r?\n/).map((line) => `    ${line}`).join("\n");
}
