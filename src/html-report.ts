import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { compareRunContractSet } from "./contract.js";
import { loadArtifactInspection } from "./artifact-inspection.js";
import { divergesFromValidation, loadConformanceProbe } from "./conformance.js";
import { isEditTool } from "./metrics.js";
import type {
  ArtifactInspection,
  BenchmarkRun,
  ConformanceCheckResult,
  ConformanceProbeResult,
  JudgeFinding,
  LlmEvaluationResult,
  LlmJudgeScore,
  Metric,
} from "./types.js";

/**
 * Loads the most recent `llm-evaluation-*.json` artifact from a runs directory,
 * or returns `null` when no evaluation has been produced. The file name is
 * timestamped, so lexical descending order is chronological.
 */
export function loadLatestEvaluation(directory: string): LlmEvaluationResult | null {
  const resolved = resolve(directory);
  const files = readdirSync(resolved)
    .filter((name) => name.startsWith("llm-evaluation-") && name.endsWith(".json"))
    .sort((left, right) => right.localeCompare(left));
  const latest = files[0];
  if (!latest) {
    return null;
  }
  return JSON.parse(readFileSync(join(resolved, latest), "utf8")) as LlmEvaluationResult;
}

export function writeHtmlComparisonReport(
  runs: readonly BenchmarkRun[],
  outputPath: string,
  evaluation: LlmEvaluationResult | null = null,
): void {
  writeFileSync(outputPath, renderHtmlComparisonReport(runs, evaluation), "utf8");
}

/**
 * Renders a self-contained HTML comparison report that joins the deterministic
 * run evidence with the supplementary LLM-judge evaluation (when present).
 * Unavailable metrics are labelled, not invented, and every recorded outcome —
 * including failures — is kept in the comparison.
 */
export function renderHtmlComparisonReport(
  runs: readonly BenchmarkRun[],
  evaluation: LlmEvaluationResult | null = null,
): string {
  if (runs.length === 0) {
    throw new RangeError("An HTML comparison report requires at least one completed run.");
  }
  const comparison = runs.length >= 2
    ? compareRunContractSet(runs.map((run) => run.contract))
    : { strictlyComparable: true, drift: [] as ReadonlyArray<{ path: string }> };
  const scoreByRunId = new Map((evaluation?.scores ?? []).map((score) => [score.runId, score]));
  const presentRunIds = new Set(runs.map((run) => run.runId));
  const orphanScores = (evaluation?.scores ?? []).filter((score) => !presentRunIds.has(score.runId));
  const inspections = new Map(runs.map((run) => [run.runId, loadArtifactInspection(run)]));
  const probes = new Map(runs.map((run) => [run.runId, loadConformanceProbe(run)]));

  const maxE2e = maxAvailable(runs, (run) => run.metrics.e2eMs);
  const maxTokens = maxAvailable(runs, (run) => totalTokens(run));

  const generatedAt = new Date().toISOString();
  const strict = comparison.strictlyComparable;

  return [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head>",
    "<meta charset=\"utf-8\">",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    "<title>Coding-agent benchmark comparison</title>",
    `<style>${styleSheet()}</style>`,
    "</head>",
    "<body>",
    "<main>",
    "<header class=\"page-head\">",
    "<h1>Coding-agent benchmark comparison</h1>",
    `<p class="subtitle">Model efficiency versus quality on a shared coding task. Generated ${escapeHtml(generatedAt)}.</p>`,
    "<div class=\"pills\">",
    pill(`${runs.length} run${runs.length === 1 ? "" : "s"}`, "neutral"),
    pill(`${countCandidates(runs)} candidate${countCandidates(runs) === 1 ? "" : "s"}`, "neutral"),
    pill(
      strict ? "Strictly comparable" : "Not strictly comparable — contract drift",
      strict ? "good" : "warn",
    ),
    pill(evaluation ? "LLM judge attached" : "No LLM judge", evaluation ? "info" : "muted"),
    "</div>",
    driftBlock(comparison.drift),
    "</header>",

    decisionSummarySection(runs, evaluation, scoreByRunId, strict, inspections, probes),

    "<section>",
    "<h2>Run comparison</h2>",
    "<p class=\"note\">Deterministic validation is the source of truth for the outcome. Every recorded outcome is shown, including failures. Cells marked <em>Unavailable</em> were not captured by the SDK stream and are never inferred. <strong>Code &Delta;</strong> is the agent's source diff vs the task baseline (the same evidence the LLM judge inspects).</p>",
    "<div class=\"table-wrap\">",
    "<table>",
    "<thead><tr>",
    ...["Candidate", "Outcome", "Conformance", "E2E", "Input tok", "Output tok", "Cache read", "Cost", "Model calls", "Tool calls", "TTFT", "Validation", "Code \u0394"].map((heading) => `<th>${heading}</th>`),
    "</tr></thead>",
    "<tbody>",
    ...runs.map((run) => runRow(run, maxE2e, maxTokens, probes.get(run.runId) ?? null)),
    "</tbody>",
    "</table>",
    "</div>",
    "</section>",

    conformanceSection(runs, probes),

    artifactInspectionSection(runs, inspections),

    efficiencyProfileSection(runs),

    "<section>",
    "<h2>Comparability &amp; lineage</h2>",
    "<div class=\"table-wrap\">",
    "<table>",
    "<thead><tr>",
    ...["Candidate", "Task ID", "Baseline commit", "Environment fingerprint", "Reasoning effort", "Wire adaptation"].map((heading) => `<th>${heading}</th>`),
    "</tr></thead>",
    "<tbody>",
    ...runs.map((run) => [
      "<tr>",
      `<td>${escapeHtml(candidateLabel(run))}</td>`,
      `<td>${escapeHtml(run.contract.task.id)}</td>`,
      `<td><code>${escapeHtml(run.contract.task.repository.commitSha)}</code></td>`,
      `<td><code>${escapeHtml(run.contract.task.repository.containerFingerprint)}</code></td>`,
      `<td>${escapeHtml(run.contract.execution.reasoningEffort ?? "not recorded")}</td>`,
      `<td>${escapeHtml(run.contract.foundryProvider?.requestAdaptation ?? "legacy/unknown")}</td>`,
      "</tr>",
    ].join("")),
    "</tbody>",
    "</table>",
    "</div>",
    "<p class=\"note\">Raw event, normalized event, diagnostics, and per-run report paths remain in each run's <code>run.json</code> artifact. Raw artifacts can contain prompts, model output, and tool arguments; store them per your data-handling policy.</p>",
    "</section>",

    evaluation ? judgeSection(evaluation, runs, scoreByRunId, orphanScores, inspections) : noJudgeSection(),

    "<footer>",
    "<p>Cost values are the provider's reported multiplier, not money. Converting tokens or cache reads to currency requires a versioned pricing source, region, and deployment SKU. The LLM judge, when shown, is supplementary qualitative evidence and never overrides a deterministic result.</p>",
    "</footer>",
    "</main>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

function runRow(
  run: BenchmarkRun,
  maxE2e: number | null,
  maxTokens: number | null,
  probe: ConformanceProbeResult | null,
): string {
  const e2e = metricNumber(run.metrics.e2eMs);
  const tokens = totalTokens(run);
  return [
    "<tr>",
    `<td class="candidate">${escapeHtml(candidateLabel(run))}</td>`,
    `<td>${outcomeBadge(run.outcome.class)}</td>`,
    `<td>${verdictCell(probe)}</td>`,
    `<td class="num">${barCell(formatMs(run.metrics.e2eMs), e2e, maxE2e)}</td>`,
    `<td class="num">${formatCount(run.metrics.inputTokens)}</td>`,
    `<td class="num">${formatCount(run.metrics.outputTokens)}</td>`,
    `<td class="num">${formatCount(run.metrics.cacheReadTokens)}</td>`,
    `<td class="num">${formatCost(run.metrics.cost)}</td>`,
    `<td class="num">${run.modelCalls.length}</td>`,
    `<td class="num">${run.toolCalls.length}</td>`,
    `<td class="num">${formatMs(run.metrics.timeToFirstTokenMs)}</td>`,
    `<td>${validationCell(run)}</td>`,
    `<td>${codeChangeCell(run)}</td>`,
    "</tr>",
    tokens !== null && maxTokens !== null
      ? `<tr class="subbar"><td></td><td colspan="12">${bar("Total tokens", tokens, maxTokens, formatInteger(tokens))}</td></tr>`
      : "",
  ].filter(Boolean).join("");
}

/**
 * Task-authored behavioural evidence. Validation asks whether the candidate's
 * own tests pass, which a candidate can satisfy by writing agreeable tests. A
 * probe asks whether the delivered artifact does what the task author
 * specified, using checks the agent never saw. When the two disagree, that
 * disagreement is the most important thing on the page.
 */
function conformanceSection(
  runs: readonly BenchmarkRun[],
  probes: Map<string, ConformanceProbeResult | null>,
): string {
  const probed = runs.filter((run) => probes.get(run.runId)?.available);
  if (probed.length === 0) {
    return [
      "<section>",
      "<h2>Conformance probe</h2>",
      "<p class=\"note\">No run in this comparison declared a conformance probe, so nothing here verified behaviour against task-owned expectations. A green validation command means the candidate's own tests passed &mdash; it does not establish that the artifact meets the specification. Add <code>task.conformanceProbe</code> to the benchmark config to close that gap.</p>",
      "</section>",
    ].join("\n");
  }

  // Check identity is stable across candidates, so the union of ids is the
  // matrix's row set. A candidate missing an id genuinely was not probed for it.
  const checkIds: string[] = [];
  const descriptions = new Map<string, { description: string; severity: string }>();
  for (const run of probed) {
    for (const check of probes.get(run.runId)?.checks ?? []) {
      if (!descriptions.has(check.id)) {
        checkIds.push(check.id);
        descriptions.set(check.id, { description: check.description, severity: check.severity });
      }
    }
  }

  const diverging = runs.filter((run) => divergesFromValidation(run, probes.get(run.runId) ?? null));

  return [
    "<section>",
    "<h2>Conformance probe</h2>",
    "<p class=\"note\">Task-owned checks run against the delivered artifact after validation. The agent never saw them, so a pass is evidence about the code rather than about the tests it wrote. <strong>Advisory</strong> checks record <em>Weak</em> instead of <em>Fail</em>; a check that could not execute records <em>Error</em>, which is never counted against the artifact.</p>",
    diverging.length > 0
      ? `<p class="warn-text"><strong>Validation and conformance disagree.</strong> ${diverging.map((run) => escapeHtml(candidateLabel(run))).join(", ")} passed the configured validation command while failing at least one required expectation. The recorded outcome stays <code>resolved</code> because it is anchored to that command; treat the conformance verdict as the stronger behavioural signal.</p>`
      : "",
    "<div class=\"table-wrap\">",
    "<table>",
    "<thead><tr>",
    "<th>Check</th>",
    ...runs.map((run) => `<th>${escapeHtml(candidateLabel(run))}</th>`),
    "</tr></thead>",
    "<tbody>",
    ...checkIds.map((id) => {
      const meta = descriptions.get(id);
      return [
        "<tr>",
        `<th scope="row">${escapeHtml(id)}${meta?.severity === "advisory" ? " <span class=\"badge muted\">advisory</span>" : ""}<span class="row-note">${escapeHtml(meta?.description ?? "")}</span></th>`,
        ...runs.map((run) => `<td>${checkCell(probes.get(run.runId) ?? null, id)}</td>`),
        "</tr>",
      ].join("");
    }),
    "<tr class=\"verdict-row\">",
    "<th scope=\"row\">Verdict<span class=\"row-note\">Conformant only when every required check passed.</span></th>",
    ...runs.map((run) => `<td>${verdictCell(probes.get(run.runId) ?? null)}</td>`),
    "</tr>",
    "</tbody>",
    "</table>",
    "</div>",
    ...failureDetails(runs, probes),
    "</section>",
  ].filter(Boolean).join("\n");
}

function checkCell(probe: ConformanceProbeResult | null, id: string): string {
  if (probe === null || !probe.available) {
    return "<span class=\"muted-cell\" title=\"This run declared no conformance probe.\">Not probed</span>";
  }
  const check = probe.checks.find((candidate) => candidate.id === id);
  if (check === undefined) {
    return "<span class=\"muted-cell\" title=\"This run's probe did not include this check.\">&mdash;</span>";
  }
  return conformanceBadge(check);
}

function conformanceBadge(check: ConformanceCheckResult): string {
  const title = check.status === "error"
    ? check.errorMessage ?? "The check could not be executed."
    : `${check.command} \u2192 ${check.timedOut ? "timed out" : `exit ${check.exitCode ?? "unknown"}`}`;
  const label = { pass: "Pass", weak: "Weak", fail: "Fail", error: "Error" }[check.status];
  const tone = { pass: "good", weak: "warn", fail: "bad", error: "muted" }[check.status];
  return `<span class="badge ${tone}" title="${escapeHtml(title)}">${label}</span>`;
}

function verdictCell(probe: ConformanceProbeResult | null): string {
  if (probe === null || !probe.available) {
    return "<span class=\"muted-cell\">Not probed</span>";
  }
  if (probe.conformant === null) {
    return `<span class="badge muted" title="${escapeHtml(probe.reason ?? "The probe did not execute.")}">Inconclusive</span>`;
  }
  const totals = probe.totals;
  const detail = `${totals.passed} passed, ${totals.failed} failed, ${totals.weak} weak, ${totals.errored} errored`;
  return probe.conformant
    ? `<span class="badge good" title="${escapeHtml(detail)}">Conformant</span>`
    : `<span class="badge bad" title="${escapeHtml(detail)}">Non-conformant</span>`;
}

/** Spells out every failing expectation, so a red cell is never a bare verdict. */
function failureDetails(
  runs: readonly BenchmarkRun[],
  probes: Map<string, ConformanceProbeResult | null>,
): string[] {
  const blocks: string[] = [];
  for (const run of runs) {
    const probe = probes.get(run.runId);
    if (!probe?.available) {
      continue;
    }
    const notable = probe.checks.filter((check) => check.status !== "pass");
    if (notable.length === 0) {
      continue;
    }
    const items = notable.map((check) => {
      const outcome = check.status === "error"
        ? escapeHtml(check.errorMessage ?? "could not be executed")
        : check.timedOut
          ? "timed out"
          : `exited ${check.exitCode ?? "unknown"}`;
      const evidence = firstMeaningfulLine(check.stderr) ?? firstMeaningfulLine(check.stdout);
      // The check id and its description already head the row in the matrix
      // above, so repeat neither here: the reader wants the failure, not the
      // restated expectation.
      const detail = evidence === null
        ? `The check ${outcome}.`
        : `<span class="finding-evidence">${escapeHtml(evidence)}</span>`;
      return `<li><strong>${escapeHtml(check.id)}</strong> ${conformanceBadge(check)} ${detail}</li>`;
    });
    blocks.push(`<div class="integrity"><strong>${escapeHtml(candidateLabel(run))}</strong><ul>${items.join("")}</ul></div>`);
  }
  return blocks.length === 0
    ? ["<p class=\"note\">Every probed candidate passed every required expectation.</p>"]
    : blocks;
}

function firstMeaningfulLine(output: string): string | null {
  const line = output.split(/\r?\n/).map((value) => value.trim()).find((value) => value.length > 0);
  return line === undefined ? null : line.slice(0, 240);
}

/**
 * Metrics the collector already captures but the headline table has no room
 * for. Transposed (metrics as rows, candidates as columns) because a reader
 * compares one metric across candidates, not one candidate across metrics.
 */
function efficiencyProfileSection(runs: readonly BenchmarkRun[]): string {
  const rows: Array<{ label: string; note: string; cells: string[] }> = [
    {
      label: "Time to first tool call",
      note: "How long the agent deliberated before acting on the repository.",
      cells: runs.map((run) => formatMs(run.metrics.timeToFirstToolCallMs)),
    },
    {
      label: "Time to first edit",
      note: "How long before the agent wrote anything, as opposed to reading.",
      cells: runs.map((run) => formatMs(run.metrics.timeToFirstEditMs)),
    },
    {
      label: "Time to green test",
      note: "First moment a test command the agent ran exited zero, in-session.",
      cells: runs.map((run) => formatMs(run.metrics.timeToGreenTestMs)),
    },
    {
      label: "TPOT",
      note: "Mean time per output token; requires token-level streaming deltas.",
      cells: runs.map((run) => formatMs(run.metrics.timePerOutputTokenMs)),
    },
    {
      label: "Cache read tokens",
      note: "Prompt tokens served from the provider's cache.",
      cells: runs.map((run) => formatCount(run.metrics.cacheReadTokens)),
    },
    {
      label: "Cache write tokens",
      note: "Prompt tokens written into the provider's cache.",
      cells: runs.map((run) => formatCount(run.metrics.cacheWriteTokens)),
    },
    {
      label: "Cache hit share",
      note: "Cache reads as a share of all prompt tokens. High values make raw input-token totals a poor cost proxy.",
      cells: runs.map((run) => formatRatio(cacheHitShare(run))),
    },
    {
      label: "Tokens per tool call",
      note: "Total tokens divided by tool calls. A high value means long reasoning between actions; a low one means many cheap steps.",
      cells: runs.map((run) => formatOptionalInteger(tokensPerToolCall(run))),
    },
    {
      label: "Tool calls per edit",
      note: "How much exploration each write cost. Rises when an agent re-reads what it has already seen.",
      cells: runs.map((run) => formatOptionalRate(toolCallsPerEdit(run))),
    },
  ];
  return [
    "<section>",
    "<h2>Agent efficiency profile</h2>",
    "<p class=\"note\">Derived from the recorded event stream. These describe <em>how</em> a candidate reached its outcome, which is what separates two candidates that both resolved. Nothing here is estimated: a metric the stream did not support is marked <em>Unavailable</em>.</p>",
    "<div class=\"table-wrap\">",
    "<table>",
    "<thead><tr>",
    "<th>Metric</th>",
    ...runs.map((run) => `<th>${escapeHtml(candidateLabel(run))}</th>`),
    "</tr></thead>",
    "<tbody>",
    ...rows.map((row) => [
      "<tr>",
      `<th scope="row">${escapeHtml(row.label)}<span class="row-note">${escapeHtml(row.note)}</span></th>`,
      ...row.cells.map((cell) => `<td class="num">${cell}</td>`),
      "</tr>",
    ].join("")),
    "</tbody>",
    "</table>",
    "</div>",
    "</section>",
  ].filter(Boolean).join("\n");
}

function cacheHitShare(run: BenchmarkRun): number | null {
  const cached = metricNumber(run.metrics.cacheReadTokens);
  const input = metricNumber(run.metrics.inputTokens);
  if (cached === null || input === null) {
    return null;
  }
  const prompt = cached + input;
  return prompt === 0 ? null : cached / prompt;
}

function tokensPerToolCall(run: BenchmarkRun): number | null {
  const tokens = totalTokens(run);
  return tokens === null || run.toolCalls.length === 0 ? null : tokens / run.toolCalls.length;
}

function toolCallsPerEdit(run: BenchmarkRun): number | null {
  const edits = run.toolCalls.filter((call) => isEditTool(call.toolName)).length;
  return edits === 0 ? null : run.toolCalls.length / edits;
}

function formatRatio(value: number | null): string {
  return value === null
    ? "<span class=\"muted-cell\" title=\"Requires both cache-read and input token counts.\">Unavailable</span>"
    : `${(value * 100).toFixed(1)}%`;
}

function formatOptionalInteger(value: number | null): string {
  return value === null
    ? "<span class=\"muted-cell\" title=\"Requires token counts and at least one tool call.\">Unavailable</span>"
    : formatInteger(value);
}

function formatOptionalRate(value: number | null): string {
  return value === null
    ? "<span class=\"muted-cell\" title=\"Requires at least one workspace-mutating tool call.\">Unavailable</span>"
    : value.toFixed(1);
}

/**
 * Deterministic evidence about the code each candidate actually delivered.
 * These checks run without any model and catch defects a green validation
 * command hides: entry points the build never emits, installed packages the
 * manifest does not allow, and test files collected from build output (which
 * inflates a reported test count without adding a single new assertion).
 */
function artifactInspectionSection(
  runs: readonly BenchmarkRun[],
  inspections: Map<string, ArtifactInspection>,
): string {
  const anyAvailable = runs.some((run) => inspections.get(run.runId)?.available);
  return [
    "<section>",
    "<h2>Code artifact inspection</h2>",
    "<p class=\"note\">Measured from each run's final workspace after validation &mdash; no model involved. <strong>Integrity</strong> checks flag defects that a passing test command can conceal. Counts exclude dependencies and build output.</p>",
    anyAvailable ? "" : "<p class=\"note warn-text\">No workspace was inspectable for these runs. Runs recorded before artifact capture existed have no <code>artifact-inspection.json</code>, and their workspaces may have been removed.</p>",
    "<div class=\"table-wrap\">",
    "<table>",
    "<thead><tr>",
    ...["Candidate", "Source files", "Source LOC", "Test files", "Test LOC", "Exports", "Entry points", "Dependency drift", "Tests from build output"].map((heading) => `<th>${heading}</th>`),
    "</tr></thead>",
    "<tbody>",
    ...runs.map((run) => artifactRow(run, inspections.get(run.runId))),
    "</tbody>",
    "</table>",
    "</div>",
    ...integrityDetails(runs, inspections),
    "</section>",
  ].filter(Boolean).join("\n");
}

function artifactRow(run: BenchmarkRun, inspection: ArtifactInspection | undefined): string {
  if (!inspection || !inspection.available) {
    return [
      "<tr>",
      `<td class="candidate">${escapeHtml(candidateLabel(run))}</td>`,
      `<td colspan="8" class="muted-cell">Unavailable &mdash; ${escapeHtml(inspection?.reason ?? "no artifact inspection was captured")}</td>`,
      "</tr>",
    ].join("");
  }
  const unresolved = inspection.entryPoints.filter((entry) => !entry.exists);
  const drift = inspection.dependencyDrift.filter((entry) => entry.satisfied === false || entry.installed === null);
  const shadowTests = inspection.testFilesUnderBuildOutput;
  return [
    "<tr>",
    `<td class="candidate">${escapeHtml(candidateLabel(run))}</td>`,
    `<td class="num">${inspection.totals.sourceFiles}</td>`,
    `<td class="num">${formatInteger(inspection.totals.sourceLines)}</td>`,
    `<td class="num">${inspection.totals.testFiles}</td>`,
    `<td class="num">${formatInteger(inspection.totals.testLines)}</td>`,
    `<td class="num">${inspection.exports.length}</td>`,
    `<td>${integrityBadge(unresolved.length, `${inspection.entryPoints.length} resolve`, `${unresolved.length} unresolved`)}</td>`,
    `<td>${integrityBadge(drift.length, `${inspection.dependencyDrift.length} satisfied`, `${drift.length} drifted`)}</td>`,
    `<td>${integrityBadge(shadowTests.length, "none", `${shadowTests.length} file${shadowTests.length === 1 ? "" : "s"}`)}</td>`,
    "</tr>",
  ].join("");
}

function integrityBadge(problems: number, cleanText: string, problemText: string): string {
  return problems === 0
    ? `<span class="badge good">${escapeHtml(cleanText)}</span>`
    : `<span class="badge bad">${escapeHtml(problemText)}</span>`;
}

/** Spells out every integrity flag, so a red badge is never an unexplained verdict. */
function integrityDetails(
  runs: readonly BenchmarkRun[],
  inspections: Map<string, ArtifactInspection>,
): string[] {
  const items: string[] = [];
  for (const run of runs) {
    const inspection = inspections.get(run.runId);
    if (!inspection?.available) {
      continue;
    }
    const notes: string[] = [];
    for (const entry of inspection.entryPoints.filter((candidate) => !candidate.exists)) {
      notes.push(`Manifest <code>${escapeHtml(entry.field)}</code> points at <code>${escapeHtml(entry.declared)}</code>, which the delivered artifact does not contain. Importing this package by name would fail even though its own tests pass.`);
    }
    for (const entry of inspection.dependencyDrift.filter((candidate) => candidate.satisfied === false)) {
      notes.push(`<code>${escapeHtml(entry.name)}</code> declares <code>${escapeHtml(entry.declared)}</code> but <code>${escapeHtml(entry.installed ?? "?")}</code> is installed${entry.installedIsPrerelease ? " (a pre-release)" : ""}. The validated result is not reproducible from this manifest.`);
    }
    for (const entry of inspection.dependencyDrift.filter((candidate) => candidate.installed === null)) {
      notes.push(`<code>${escapeHtml(entry.name)}</code> is declared but was not installed in the validated workspace.`);
    }
    if (inspection.testFilesUnderBuildOutput.length > 0) {
      notes.push(`${inspection.testFilesUnderBuildOutput.length} test file${inspection.testFilesUnderBuildOutput.length === 1 ? " was" : "s were"} collected from build output (${inspection.testFilesUnderBuildOutput.map((path) => `<code>${escapeHtml(path)}</code>`).join(", ")}). A reported test count that includes these counts the same assertions twice.`);
    }
    if (notes.length > 0) {
      items.push(`<div class="integrity"><strong>${escapeHtml(candidateLabel(run))}</strong><ul>${notes.map((note) => `<li>${note}</li>`).join("")}</ul></div>`);
    }
  }
  return items.length === 0
    ? ["<p class=\"note\">No integrity problems were detected in any inspectable artifact.</p>"]
    : items;
}
function judgeSection(
  evaluation: LlmEvaluationResult,
  runs: readonly BenchmarkRun[],
  scoreByRunId: Map<string, LlmJudgeScore>,
  orphanScores: readonly LlmJudgeScore[],
  inspections: Map<string, ArtifactInspection>,
): string {
  const judge = evaluation.judge;
  const readsFullSource = judge.promptVersion === "benchmark-judge-v3";
  const insights = evaluation.comparativeInsights ?? [];
  const findings = runs.flatMap((run) => (scoreByRunId.get(run.runId)?.findings ?? []).map((finding) => ({
    finding,
    candidate: candidateLabel(run),
  })));
  return [
    "<section>",
    "<h2>LLM-judge code review</h2>",
    readsFullSource
      ? "<p class=\"note\">The judge read each candidate's <em>final source files</em> (line-numbered), its package manifest, and the deterministic integrity results above &mdash; never raw prompts or tool transcripts. Every finding must cite a real <code>file:line</code>; the harness re-checks each citation against the inspected artifact and marks any it cannot anchor. This is supplementary qualitative evidence and never overrides the deterministic outcome.</p>"
      : "<p class=\"note warn-text\">This evaluation was produced by an earlier prompt version that saw only a truncated diff, not the final source. Re-run <code>npm run evaluate</code> to get citation-anchored findings over the full artifact.</p>",
    "<div class=\"pills\">",
    pill(`Judge: ${judge.model}`, "info"),
    pill(`Effort: ${judge.reasoningEffort}`, "neutral"),
    pill(`Prompt: ${judge.promptVersion}`, readsFullSource ? "good" : "warn"),
    pill(`Endpoint ${judge.endpointFingerprint.slice(0, 12)}\u2026`, "muted"),
    "</div>",
    "<h3>Judge's comparative read</h3>",
    `<blockquote class="lead">${escapeHtml(evaluation.comparisonSummary)}</blockquote>`,
    dimensionMatrix(runs, scoreByRunId),
    comparativeInsightsBlock(insights),
    findingsBlock(findings),
    "<h3>Per-candidate analysis</h3>",
    "<div class=\"quality-grid\">",
    ...runs.map((run) => judgeCard(run, scoreByRunId.get(run.runId), inspections.get(run.runId))),
    "</div>",
    "<h3>Stated limitations of this evaluation</h3>",
    evaluation.limitations.length === 0
      ? "<p class=\"note\">None stated.</p>"
      : `<ul class="limitations">${evaluation.limitations.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`,
    orphanScores.length === 0
      ? ""
      : `<p class="note warn-text">${orphanScores.length} judged run${orphanScores.length === 1 ? " is" : "s are"} no longer present in this runs directory and ${orphanScores.length === 1 ? "was" : "were"} omitted: ${orphanScores.map((score) => `<code>${escapeHtml(score.runId)}</code>`).join(", ")}.</p>`,
    "</section>",
  ].join("\n");
}

/** Dimensions as rows and candidates as columns, so the table stays readable as N grows. */
function dimensionMatrix(runs: readonly BenchmarkRun[], scoreByRunId: Map<string, LlmJudgeScore>): string {
  const dimensions: Array<{ label: string; read: (score: LlmJudgeScore) => number | undefined }> = [
    { label: "Correctness", read: (score) => score.correctness },
    { label: "Test adequacy", read: (score) => score.testAdequacy },
    { label: "API design", read: (score) => score.apiDesign },
    { label: "Reproducibility", read: (score) => score.reproducibility },
    { label: "Requirement coverage", read: (score) => score.requirementCoverage },
    { label: "Maintainability", read: (score) => score.maintainability },
    { label: "Code quality (overall)", read: (score) => score.codeQuality },
  ];
  const present = dimensions.filter((dimension) => runs.some((run) => {
    const score = scoreByRunId.get(run.runId);
    return score !== undefined && dimension.read(score) !== undefined;
  }));
  if (present.length === 0) {
    return "";
  }
  return [
    "<h3>Score dimensions</h3>",
    "<div class=\"table-wrap\">",
    "<table>",
    `<thead><tr><th>Dimension</th>${runs.map((run) => `<th>${escapeHtml(candidateLabel(run))}</th>`).join("")}</tr></thead>`,
    "<tbody>",
    ...present.map((dimension) => [
      `<tr><th scope="row">${escapeHtml(dimension.label)}</th>`,
      ...runs.map((run) => {
        const score = scoreByRunId.get(run.runId);
        const value = score ? dimension.read(score) : undefined;
        return `<td class="num">${value === undefined ? "<span class=\"muted-cell\">&mdash;</span>" : scoreBadge(value)}</td>`;
      }),
      "</tr>",
    ].join("")),
    `<tr><th scope="row">Evidence confidence</th>${runs.map((run) => {
      const score = scoreByRunId.get(run.runId);
      return `<td class="num">${score ? confidenceBadge(score.evidenceConfidence) : "<span class=\"muted-cell\">&mdash;</span>"}</td>`;
    }).join("")}</tr>`,
    "</tbody>",
    "</table>",
    "</div>",
    "<p class=\"note\">Integers 1&ndash;5. A dash means this judge run did not report that dimension. Dimensions are deliberately unweighted: a fast, small implementation and a thorough, slower one should be readable as different profiles rather than collapsed into one number.</p>",
  ].join("\n");
}

function comparativeInsightsBlock(insights: readonly { theme: string; observation: string; candidates: string[] }[]): string {
  if (insights.length === 0) {
    return "";
  }
  return [
    "<h3>Cross-candidate divergences</h3>",
    "<p class=\"note\">Observations that only appear when the implementations are read side by side &mdash; per-candidate scoring cannot produce these.</p>",
    "<div class=\"insight-grid\">",
    ...insights.map((insight) => [
      "<article class=\"insight\">",
      `<span class="insight-theme">${escapeHtml(insight.theme)}</span>`,
      `<p>${escapeHtml(insight.observation)}</p>`,
      insight.candidates.length === 0
        ? ""
        : `<div class="insight-candidates">${insight.candidates.map((candidate) => `<code>${escapeHtml(candidate)}</code>`).join(" ")}</div>`,
      "</article>",
    ].join("")),
    "</div>",
  ].join("\n");
}

/**
 * Findings ordered by severity, each anchored to a line of inspected code.
 * Citations the harness could not resolve are shown but explicitly marked, so a
 * reviewer can tell a checked claim from an unanchored one at a glance.
 */
function findingsBlock(entries: ReadonlyArray<{ finding: JudgeFinding; candidate: string }>): string {
  if (entries.length === 0) {
    return "";
  }
  const rank = { high: 0, medium: 1, low: 2 } as const;
  const ordered = [...entries].sort((left, right) =>
    rank[left.finding.severity] - rank[right.finding.severity] || left.candidate.localeCompare(right.candidate));
  const unverified = ordered.filter((entry) => !entry.finding.citationVerified).length;
  return [
    "<h3>Code findings</h3>",
    `<p class="note">${ordered.length} finding${ordered.length === 1 ? "" : "s"}, highest severity first. ${
      unverified === 0
        ? "Every citation resolved to a real line in the inspected artifact."
        : `${unverified} citation${unverified === 1 ? " could" : "s could"} not be resolved against the inspected artifact and ${unverified === 1 ? "is" : "are"} marked <span class="badge warn">unverified</span> &mdash; treat ${unverified === 1 ? "it" : "them"} as an unchecked claim.`
    }</p>`,
    "<div class=\"table-wrap\">",
    "<table>",
    "<thead><tr><th>Severity</th><th>Candidate</th><th>Location</th><th>Category</th><th>Finding</th></tr></thead>",
    "<tbody>",
    ...ordered.map(({ finding, candidate }) => [
      "<tr>",
      `<td><span class="badge ${finding.severity === "high" ? "bad" : finding.severity === "medium" ? "warn" : "muted"}">${escapeHtml(finding.severity)}</span></td>`,
      `<td class="candidate">${escapeHtml(candidate)}</td>`,
      `<td><code>${escapeHtml(finding.file)}${finding.line === null ? "" : `:${finding.line}`}</code>${finding.citationVerified ? "" : " <span class=\"badge warn\">unverified</span>"}</td>`,
      `<td><span class="dim">${escapeHtml(finding.category)}</span></td>`,
      `<td>${escapeHtml(finding.claim)}${finding.evidence ? `<div class="finding-evidence"><code>${escapeHtml(finding.evidence)}</code></div>` : ""}</td>`,
      "</tr>",
    ].join("")),
    "</tbody>",
    "</table>",
    "</div>",
  ].join("\n");
}

function judgeCard(
  run: BenchmarkRun,
  score: LlmJudgeScore | undefined,
  inspection: ArtifactInspection | undefined,
): string {
  if (!score) {
    return [
      "<article class=\"quality-card muted\">",
      `<div class="quality-head"><span class="candidate">${escapeHtml(candidateLabel(run))}</span></div>`,
      "<p class=\"muted-cell\">Not evaluated by this judge run.</p>",
      "</article>",
    ].join("");
  }
  const overall = score.codeQuality + score.requirementCoverage + score.maintainability;
  return [
    `<article class="quality-card tone-${scoreTone(Math.round(overall / 3))}">`,
    "<div class=\"quality-head\">",
    `<span class="candidate">${escapeHtml(candidateLabel(run))}</span>`,
    `${confidenceBadge(score.evidenceConfidence)} confidence`,
    "</div>",
    "<div class=\"score-chips\">",
    scoreChip("Code quality", score.codeQuality),
    scoreChip("Requirements", score.requirementCoverage),
    scoreChip("Maintainability", score.maintainability),
    "</div>",
    reviewCoverage(score, inspection),
    `<p class="rationale-text">${escapeHtml(score.rationale)}</p>`,
    score.risks.length === 0
      ? "<p class=\"muted-cell\">No risks reported.</p>"
      : `<div class="risks"><span class="risks-label">Risks &amp; caveats</span><ul>${score.risks.map((risk) => `<li>${escapeHtml(risk)}</li>`).join("")}</ul></div>`,
    "</article>",
  ].join("");
}

/**
 * States how much of the artifact the judge claims to have read, measured
 * against what the harness put in front of it. Coverage is the honest bound on
 * how far a qualitative score can be trusted.
 */
function reviewCoverage(score: LlmJudgeScore, inspection: ArtifactInspection | undefined): string {
  if (!inspection?.available) {
    return "<p class=\"coverage muted-cell\">No inspected artifact to compare the review against.</p>";
  }
  const reviewable = inspection.sources.length;
  const reviewed = score.reviewedFiles?.length;
  if (reviewed === undefined) {
    return `<p class="coverage">Artifact contained <strong>${reviewable}</strong> reviewable file${reviewable === 1 ? "" : "s"}; this judge run did not report which it read.</p>`;
  }
  return `<p class="coverage">Reviewed <strong>${reviewed}</strong> of <strong>${reviewable}</strong> reviewable file${reviewable === 1 ? "" : "s"}.</p>`;
}

function scoreChip(label: string, value: number): string {
  return `<span class="chip"><span class="chip-label">${escapeHtml(label)}</span>${scoreBadge(value)}</span>`;
}

function scoreTone(value: number): "good" | "warn" | "bad" {
  return value >= 4 ? "good" : value === 3 ? "warn" : "bad";
}

/**
 * A short, data-derived decision summary. Every figure is read directly from the
 * runs or the judge evaluation — nothing is inferred. The quality card only
 * appears when an LLM evaluation is attached.
 */
function decisionSummarySection(
  runs: readonly BenchmarkRun[],
  evaluation: LlmEvaluationResult | null,
  scoreByRunId: Map<string, LlmJudgeScore>,
  strict: boolean,
  inspections: Map<string, ArtifactInspection>,
  probes: Map<string, ConformanceProbeResult | null>,
): string {
  const cards: string[] = [];

  const fastest = fastestResolved(runs);
  if (fastest) {
    cards.push(statCard(
      "Fastest deterministic pass",
      candidateLabel(fastest.run),
      `${formatDurationMs(fastest.e2e)} end-to-end, ${fastest.run.modelCalls.length} model calls, ${fastest.run.toolCalls.length} tool calls.`,
    ));
  }

  const probed = runs.filter((run) => probes.get(run.runId)?.available);
  if (probed.length > 0) {
    const conformant = probed.filter((run) => probes.get(run.runId)?.conformant === true);
    const diverging = probed.filter((run) => divergesFromValidation(run, probes.get(run.runId) ?? null));
    cards.push(statCard(
      "Conformance",
      `${conformant.length} of ${probed.length} conformant`,
      diverging.length > 0
        ? `${diverging.map((run) => escapeHtml(candidateLabel(run))).join(", ")} passed the validation command while failing a required task-owned expectation. A green test command proves the candidate agrees with itself, not that it met the specification.`
        : conformant.length === probed.length
          ? "Every probed artifact met every required expectation the task author defined, using checks the agent never saw."
          : "Some probed artifacts failed required expectations. See the conformance probe section.",
    ));
  }

  const inspected = runs.filter((run) => inspections.get(run.runId)?.available);
  if (inspected.length > 0) {
    const flagged = inspected.filter((run) => integrityProblemCount(inspections.get(run.runId)) > 0);
    cards.push(statCard(
      "Artifact integrity",
      flagged.length === 0 ? `${inspected.length}/${inspected.length} clean` : `${flagged.length} of ${inspected.length} flagged`,
      flagged.length === 0
        ? "Every inspected artifact resolves its manifest entry points, installs dependencies its manifest allows, and collects tests only from source."
        : `Deterministic checks found problems a passing test command hides in: ${flagged.map((run) => escapeHtml(candidateLabel(run))).join(", ")}. See the artifact inspection section.`,
    ));
  }

  if (evaluation) {
    const best = highestJudgedQuality(runs, scoreByRunId);
    if (best) {
      const s = best.score;
      cards.push(statCard(
        "Highest judged code quality",
        candidateLabel(best.run),
        `Judge scored code quality ${s.codeQuality}/5, requirements ${s.requirementCoverage}/5, maintainability ${s.maintainability}/5 (${escapeHtml(s.evidenceConfidence)} confidence).`,
      ));
    }
  }

  cards.push(statCard(
    "Key interpretation constraint",
    !strict ? "Not strictly comparable" : allCostsUnpriced(runs) ? "Costs are unpriced" : "Same-scenario comparison",
    !strict
      ? "Candidate/provider identity differs, so contract hashes diverge. Read this as a same-scenario comparison, not an identical-contract cost experiment."
      : allCostsUnpriced(runs)
        ? "Provider telemetry reported no monetary cost. Token and cache figures are diagnostic, not an invoice or normalized currency ranking."
        : "Efficiency figures are comparable; the LLM quality read below is supplementary and never overrides the deterministic outcome.",
  ));

  return [
    "<section>",
    "<h2>Decision summary</h2>",
    `<p class="note">Derived directly from the ${runs.length} recorded run${runs.length === 1 ? "" : "s"}${evaluation ? " and the attached LLM evaluation" : ""}. Deterministic validation remains the source of truth; the quality read is supplementary.</p>`,
    `<div class="stat-grid">${cards.join("")}</div>`,
    "</section>",
  ].join("\n");
}

function statCard(label: string, headline: string, detail: string): string {
  return `<article class="stat-card"><span class="stat-label">${escapeHtml(label)}</span><strong class="stat-headline">${escapeHtml(headline)}</strong><span class="stat-detail">${detail}</span></article>`;
}

function fastestResolved(runs: readonly BenchmarkRun[]): { run: BenchmarkRun; e2e: number } | null {
  let best: { run: BenchmarkRun; e2e: number } | null = null;
  for (const run of runs) {
    if (run.outcome.class !== "resolved") {
      continue;
    }
    const e2e = metricNumber(run.metrics.e2eMs);
    if (e2e === null) {
      continue;
    }
    if (best === null || e2e < best.e2e) {
      best = { run, e2e };
    }
  }
  return best;
}

function highestJudgedQuality(
  runs: readonly BenchmarkRun[],
  scoreByRunId: Map<string, LlmJudgeScore>,
): { run: BenchmarkRun; score: LlmJudgeScore } | null {
  let best: { run: BenchmarkRun; score: LlmJudgeScore; total: number } | null = null;
  for (const run of runs) {
    const score = scoreByRunId.get(run.runId);
    if (!score) {
      continue;
    }
    const total = score.codeQuality * 2 + score.requirementCoverage + score.maintainability;
    if (best === null || total > best.total) {
      best = { run, score, total };
    }
  }
  return best ? { run: best.run, score: best.score } : null;
}

function allCostsUnpriced(runs: readonly BenchmarkRun[]): boolean {
  return runs.every((run) => {
    const cost = metricNumber(run.metrics.cost);
    return cost === null || cost === 0;
  });
}

/** Deterministic integrity problems: unresolved entry points, dependency drift, shadowed tests. */
function integrityProblemCount(inspection: ArtifactInspection | undefined): number {
  if (!inspection?.available) {
    return 0;
  }
  return inspection.entryPoints.filter((entry) => !entry.exists).length
    + inspection.dependencyDrift.filter((entry) => entry.satisfied === false || entry.installed === null).length
    + inspection.testFilesUnderBuildOutput.length;
}

function noJudgeSection(): string {
  return [
    "<section>",
    "<h2>LLM-judge quality evaluation</h2>",
    "<p class=\"note\">No <code>llm-evaluation-*.json</code> artifact was found in the runs directory, so no qualitative scores are shown. Produce one with <code>npm run evaluate</code>, then regenerate this report to include quality scores alongside the efficiency metrics.</p>",
    "</section>",
  ].join("\n");
}

function driftBlock(drift: ReadonlyArray<{ path: string }>): string {
  if (drift.length === 0) {
    return "";
  }
  return [
    "<div class=\"drift\">",
    "<strong>Contract drift detected — this comparison is not strictly comparable.</strong>",
    `<div class="drift-paths">${drift.map((item) => `<code>${escapeHtml(item.path)}</code>`).join(" ")}</div>`,
    "</div>",
  ].join("");
}

function barCell(text: string, value: number | null, max: number | null): string {
  if (value === null || max === null || max <= 0) {
    return escapeHtml(text);
  }
  return `${escapeHtml(text)}<div class="minibar" style="width:${Math.max(2, Math.round((value / max) * 100))}%"></div>`;
}

function bar(label: string, value: number, max: number, text: string): string {
  const width = max <= 0 ? 0 : Math.max(2, Math.round((value / max) * 100));
  return `<div class="bar-row"><span class="bar-label">${escapeHtml(label)}</span><span class="bar-track"><span class="bar-fill" style="width:${width}%"></span></span><span class="bar-value">${escapeHtml(text)}</span></div>`;
}

function validationCell(run: BenchmarkRun): string {
  const validation = run.validation;
  if (!validation) {
    return "<span class=\"muted-cell\">Unavailable</span>";
  }
  if (validation.errorMessage) {
    return `<span class="badge warn">harness failure</span>`;
  }
  const pass = validation.exitCode === 0 && !validation.timedOut;
  return `<span class="badge ${pass ? "good" : "bad"}">exit ${validation.exitCode ?? "?"}</span> <span class="dim">${escapeHtml(formatDurationMs(validation.durationMs))}${validation.timedOut ? " · timed out" : ""}</span>`;
}

function outcomeBadge(outcome: BenchmarkRun["outcome"]["class"]): string {
  const tone = outcome === "resolved" ? "good" : outcome === "unresolved" ? "bad" : "warn";
  return `<span class="badge ${tone}">${escapeHtml(outcome)}</span>`;
}

function codeChangeCell(run: BenchmarkRun): string {
  const summary = codeChangeSummary(run);
  if (!summary) {
    return "<span class=\"muted-cell\" title=\"No changes.patch artifact for this run\">Not captured</span>";
  }
  if (summary.filesChanged === 0) {
    return "<span class=\"muted-cell\">Empty diff</span>";
  }
  return `<span class="dim">${summary.filesChanged} file${summary.filesChanged === 1 ? "" : "s"}</span> <span class="add">+${formatInteger(summary.insertions)}</span> <span class="del">\u2212${formatInteger(summary.deletions)}</span>`;
}

interface CodeChangeSummary {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

function codeChangeSummary(run: BenchmarkRun): CodeChangeSummary | null {
  const path = run.artifacts.changes ?? join(run.artifacts.directory, "changes.patch");
  if (!existsSync(path)) {
    return null;
  }
  let patch: string;
  try {
    patch = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      filesChanged += 1;
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      insertions += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      deletions += 1;
    }
  }
  return { filesChanged, insertions, deletions };
}

function scoreBadge(value: number): string {
  const tone = value >= 4 ? "good" : value === 3 ? "warn" : "bad";
  return `<span class="score ${tone}">${value}</span>`;
}

function confidenceBadge(confidence: LlmJudgeScore["evidenceConfidence"]): string {
  const tone = confidence === "high" ? "good" : confidence === "medium" ? "warn" : "muted";
  return `<span class="badge ${tone}">${escapeHtml(confidence)}</span>`;
}

function pill(text: string, tone: "good" | "warn" | "info" | "neutral" | "muted"): string {
  return `<span class="pill ${tone}">${escapeHtml(text)}</span>`;
}

function totalTokens(run: BenchmarkRun): number | null {
  const input = metricNumber(run.metrics.inputTokens);
  const output = metricNumber(run.metrics.outputTokens);
  return input === null || output === null ? null : input + output;
}

function maxAvailable(runs: readonly BenchmarkRun[], selector: (run: BenchmarkRun) => Metric<number> | number | null): number | null {
  const values = runs.flatMap((run) => {
    const raw = selector(run);
    const value = typeof raw === "number" || raw === null ? raw : metricNumber(raw);
    return value === null ? [] : [value];
  });
  return values.length === 0 ? null : Math.max(...values);
}

function metricNumber(metric: Metric<number>): number | null {
  return metric.status === "available" && typeof metric.value === "number" ? metric.value : null;
}

function formatCount(metric: Metric<number>): string {
  const value = metricNumber(metric);
  return value === null ? unavailable(metric) : formatInteger(value);
}

/**
 * A reported cost of exactly zero means the provider returned no priced usage,
 * not that the run was free. Rendering it as the integer `0` invites a reader to
 * average it with real numbers, so it is labeled instead.
 */
function formatCost(metric: Metric<number>): string {
  const value = metricNumber(metric);
  if (value === null) {
    return unavailable(metric);
  }
  return value === 0
    ? "<span class=\"muted-cell\" title=\"The provider reported no priced usage for this run. Zero is the absence of a price signal, not a zero-cost run.\">Unpriced</span>"
    : formatInteger(value);
}

function formatMs(metric: Metric<number>): string {
  const value = metricNumber(metric);
  return value === null ? unavailable(metric) : formatDurationMs(value);
}

function unavailable(metric: Metric<number>): string {
  return `<span class="muted-cell" title="${escapeHtml(metric.reason ?? "not captured")}">Unavailable</span>`;
}

function formatDurationMs(value: number): string {
  if (value >= 60_000) {
    return `${(value / 60_000).toFixed(2)}m`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(2)}s`;
  }
  return `${Math.round(value)}ms`;
}

function formatInteger(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function candidateLabel(run: BenchmarkRun): string {
  const candidate = run.contract.candidate;
  return `${candidate.provider}/${candidate.model}${candidate.deployment ? `/${candidate.deployment}` : ""}`;
}

function countCandidates(runs: readonly BenchmarkRun[]): number {
  return new Set(runs.map(candidateLabel)).size;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function styleSheet(): string {
  return [
    ":root{color-scheme:light dark;--bg:#0d1117;--panel:#161b22;--border:#30363d;--text:#e6edf3;--dim:#8b949e;--good:#2ea043;--warn:#bb8009;--bad:#cf222e;--info:#1f6feb;--accent:#388bfd}",
    "@media (prefers-color-scheme: light){:root{--bg:#ffffff;--panel:#f6f8fa;--border:#d0d7de;--text:#1f2328;--dim:#636c76;--good:#1a7f37;--warn:#9a6700;--bad:#cf222e;--info:#0969da;--accent:#0969da}}",
    "*{box-sizing:border-box}",
    "body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif}",
    "main{max-width:1160px;margin:0 auto;padding:32px 24px 64px}",
    "h1{font-size:24px;margin:0 0 4px}h2{font-size:19px;margin:36px 0 8px;padding-bottom:6px;border-bottom:1px solid var(--border)}h3{font-size:15px;margin:20px 0 6px}",
    ".subtitle{color:var(--dim);margin:0 0 14px}",
    ".pills{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0}",
    ".pill{font-size:12px;padding:3px 10px;border-radius:999px;border:1px solid var(--border);background:var(--panel)}",
    ".pill.good{color:var(--good);border-color:var(--good)}.pill.warn{color:var(--warn);border-color:var(--warn)}.pill.info{color:var(--info);border-color:var(--info)}.pill.muted{color:var(--dim)}",
    ".drift{margin:12px 0;padding:10px 14px;border:1px solid var(--warn);border-radius:8px;background:color-mix(in srgb,var(--warn) 12%,transparent)}",
    ".drift-paths{margin-top:6px;display:flex;flex-wrap:wrap;gap:6px}",
    ".note{color:var(--dim);font-size:13px;margin:6px 0 12px}.warn-text{color:var(--warn)}",
    ".table-wrap{overflow-x:auto;border:1px solid var(--border);border-radius:8px}",
    "table{border-collapse:collapse;width:100%;font-size:13px}",
    "th,td{padding:8px 12px;text-align:left;border-bottom:1px solid var(--border);vertical-align:top}",
    "th{background:var(--panel);font-weight:600;white-space:nowrap;position:sticky;top:0}",
    "td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}",
    "td.candidate{font-weight:600;white-space:nowrap}",
    "td.rationale{min-width:240px;max-width:360px;color:var(--text)}",
    "tr.subbar td{padding-top:0;padding-bottom:10px;border-bottom:1px solid var(--border)}",
    ".minibar{height:3px;margin-top:4px;background:var(--accent);border-radius:2px;opacity:.7}",
    ".bar-row{display:flex;align-items:center;gap:10px;font-size:12px;color:var(--dim)}",
    ".bar-label{width:88px;flex:none}.bar-value{width:80px;flex:none;text-align:right;font-variant-numeric:tabular-nums}",
    ".bar-track{flex:1;height:8px;background:var(--panel);border:1px solid var(--border);border-radius:4px;overflow:hidden}",
    ".bar-fill{display:block;height:100%;background:var(--accent)}",
    ".badge{display:inline-block;font-size:12px;padding:2px 8px;border-radius:6px;border:1px solid var(--border);white-space:nowrap}",
    ".badge.good{color:var(--good);border-color:var(--good)}.badge.bad{color:var(--bad);border-color:var(--bad)}.badge.warn{color:var(--warn);border-color:var(--warn)}.badge.muted{color:var(--dim)}",
    ".score{display:inline-block;min-width:26px;text-align:center;font-weight:700;padding:2px 6px;border-radius:6px;color:#fff}",
    ".score.good{background:var(--good)}.score.warn{background:var(--warn)}.score.bad{background:var(--bad)}",
    ".dim{color:var(--dim)}.muted-cell{color:var(--dim);font-style:italic}",
    ".add{color:var(--good);font-variant-numeric:tabular-nums}.del{color:var(--bad);font-variant-numeric:tabular-nums}",
    "code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;background:var(--panel);padding:1px 5px;border-radius:4px;border:1px solid var(--border)}",
    "blockquote{margin:8px 0;padding:10px 14px;border-left:3px solid var(--accent);background:var(--panel);border-radius:0 6px 6px 0}",
    "blockquote.lead{font-size:14.5px;line-height:1.6}",
    ".stat-grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));margin:8px 0}",
    ".stat-card{border:1px solid var(--border);border-left:4px solid var(--accent);border-radius:10px;background:var(--panel);padding:14px 16px;display:flex;flex-direction:column;gap:4px}",
    ".stat-label{font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--dim)}",
    ".stat-headline{font-size:16px;line-height:1.25}",
    ".stat-detail{font-size:12.5px;color:var(--dim)}",
    ".quality-grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));margin:8px 0}",
    ".quality-card{border:1px solid var(--border);border-top:4px solid var(--accent);border-radius:10px;background:var(--panel);padding:16px}",
    ".quality-card.tone-good{border-top-color:var(--good)}.quality-card.tone-warn{border-top-color:var(--warn)}.quality-card.tone-bad{border-top-color:var(--bad)}.quality-card.muted{border-top-color:var(--border)}",
    ".quality-head{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:12px;color:var(--dim)}",
    ".quality-head .candidate{font-size:14px;font-weight:700;color:var(--text)}",
    ".score-chips{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}",
    ".chip{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--dim);border:1px solid var(--border);border-radius:999px;padding:3px 6px 3px 10px;background:var(--bg)}",
    ".chip-label{letter-spacing:.02em;text-transform:uppercase;font-weight:600}",
    ".rationale-text{font-size:13px;line-height:1.55;margin:10px 0}",
    ".risks{margin-top:8px}.risks-label{font-size:11px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;color:var(--warn)}",
    ".integrity{border-left:3px solid var(--bad);background:rgba(239,68,68,.06);border-radius:0 8px 8px 0;padding:10px 14px;margin:10px 0}",
    ".verdict-row{background:#f6f8fa}.verdict-row th[scope=row],.verdict-row td{border-top:2px solid var(--border)}",
    ".integrity strong{display:block;font-size:13px;margin-bottom:4px}.integrity ul{margin:0;padding-left:18px}.integrity li{margin:4px 0;font-size:12.5px;line-height:1.5}",
    ".insight-grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));margin:8px 0}",
    ".insight{border:1px solid var(--line);border-radius:10px;padding:12px 14px;background:var(--panel)}",
    ".insight-theme{display:block;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--accent);margin-bottom:6px}",
    ".insight p{margin:0;font-size:13px;line-height:1.55}.insight-candidates{margin-top:8px;display:flex;flex-wrap:wrap;gap:6px}",
    ".finding-evidence{margin-top:5px;font-size:11.5px;opacity:.75;word-break:break-word}",
    ".coverage{margin:6px 0 0;font-size:12px;opacity:.8}",
    "tbody th[scope=row]{text-align:left;font-weight:600;white-space:nowrap}",
    "tbody th[scope=row] .row-note{display:block;font-weight:400;font-size:11px;color:#57606a;white-space:normal;max-width:22rem;margin-top:2px}",
    ".risks ul{margin:4px 0 0;padding-left:18px}.risks li{margin:3px 0;font-size:12.5px}",
    "ul{margin:4px 0;padding-left:18px}.limitations li{margin:3px 0}",
    "footer{margin-top:40px;padding-top:14px;border-top:1px solid var(--border);color:var(--dim);font-size:12px}",
  ].join("");
}
