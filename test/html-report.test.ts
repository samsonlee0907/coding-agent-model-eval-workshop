import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { immutableContractHash } from "../src/contract.js";
import { renderHtmlComparisonReport } from "../src/html-report.js";
import type { BenchmarkRun, ConformanceProbeResult, DerivedMetrics, LlmEvaluationResult, Metric, RunContract } from "../src/types.js";

function available(value: number): Metric<number> {
  return { status: "available", value };
}

function unavailable(reason: string): Metric<number> {
  return { status: "unavailable", value: null, reason };
}

function metrics(overrides: Partial<DerivedMetrics> = {}): DerivedMetrics {
  return {
    e2eMs: available(700_000),
    timeToFirstToolCallMs: available(150_000),
    timeToFirstEditMs: available(220_000),
    timeToGreenTestMs: available(700_000),
    timeToFirstTokenMs: available(3_500),
    timePerOutputTokenMs: available(3),
    inputTokens: available(200_000),
    outputTokens: available(7_000),
    cacheReadTokens: available(190_000),
    cacheWriteTokens: available(0),
    cost: available(0),
    ...overrides,
  };
}

function contractFor(provider: string, model: string): RunContract {
  return {
    contractVersion: 1,
    task: {
      id: "task-1",
      prompt: "Build the ordering system.",
      repository: { commitSha: "abc123", containerFingerprint: "image:1" },
      validationCommand: "npm test",
    },
    candidate: { provider, model, deployment: "local-byok" },
    execution: {
      instructions: "Be careful.",
      tools: ["read", "edit", "shell"],
      permissionMode: "approve-all",
      concurrency: 1,
      retries: 0,
      sessionTimeoutMs: 900_000,
      streaming: true,
      cachePolicy: "default",
      reasoningEffort: "high",
    },
    runtime: { sdkVersion: "1.0.10", cliVersion: "1", nodeVersion: "v22" },
  };
}

function run(
  runId: string,
  provider: string,
  model: string,
  outcome: BenchmarkRun["outcome"],
  metricOverrides: Partial<DerivedMetrics> = {},
): BenchmarkRun {
  const contract = contractFor(provider, model);
  return {
    runId,
    contract,
    contractHash: immutableContractHash(contract),
    sessionId: "session-1",
    startedAt: "2026-08-20T03:28:49.000Z",
    completedAt: "2026-08-20T03:40:31.000Z",
    artifacts: {
      directory: "artifacts",
      rawEvents: "raw.ndjson",
      normalizedEvents: "normalized.ndjson",
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
    modelCalls: [],
    toolCalls: [],
    usageMetrics: null,
    validation: {
      command: "npm test && npm run build",
      startedAt: "2026-08-20T03:40:26.000Z",
      completedAt: "2026-08-20T03:40:31.000Z",
      durationMs: 4_900,
      exitCode: 0,
      timedOut: false,
      errorMessage: null,
      stdout: "",
      stderr: "",
    },
    metrics: metrics(metricOverrides),
    outcome,
    runnerError: null,
  };
}

function evaluationFor(runIds: readonly string[]): LlmEvaluationResult {
  return {
    schemaVersion: 1,
    createdAt: "2026-08-20T04:30:41.512Z",
    judge: {
      type: "anthropic",
      endpointFingerprint: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      requestAdaptation: "strip-temperature",
      model: "claude-opus-5",
      reasoningEffort: "high",
      promptVersion: "benchmark-judge-v1",
    },
    evaluatedRunIds: [...runIds],
    scores: runIds.map((runId, index) => ({
      runId,
      candidate: `openai/model-${index}/local-byok`,
      codeQuality: index === 0 ? 5 : 3,
      requirementCoverage: 4,
      maintainability: index === 0 ? 4 : 2,
      evidenceConfidence: "low" as const,
      rationale: `Rationale for ${runId} with <script> unsafe & "quoted".`,
      risks: index === 0 ? ["A stated risk"] : [],
    })),
    comparisonSummary: "Candidate A leads on maintainability.",
    limitations: ["Judged from artifacts only."],
    rawResponse: "{}",
  };
}

const resolved: BenchmarkRun["outcome"] = { class: "resolved", category: "deterministic-evaluator", detail: "passed" };
const failed: BenchmarkRun["outcome"] = { class: "unresolved", category: "deterministic-evaluator", detail: "tests failed" };

test("html report joins judge scores to runs by runId and renders both tables", () => {
  const runs = [
    run("run-a", "openai", "model-a", resolved),
    run("run-b", "anthropic", "model-b", failed),
  ];
  const html = renderHtmlComparisonReport(runs, evaluationFor(["run-a", "run-b"]));

  assert.match(html, /<!doctype html>/);
  assert.match(html, /Run comparison/);
  assert.match(html, /LLM-judge code review/);
  assert.match(html, /openai\/model-a\/local-byok/);
  assert.match(html, /claude-opus-5/);
  // Deterministic outcome badges for every run, including the failure.
  assert.match(html, /badge good">resolved/);
  assert.match(html, /badge bad">unresolved/);
  // Judge score cells rendered.
  assert.match(html, /class="score good">5</);
});

test("html report labels unavailable metrics instead of inventing them", () => {
  const runs = [
    run("run-a", "openai", "model-a", resolved, { timeToFirstTokenMs: unavailable("no streaming deltas") }),
    run("run-b", "anthropic", "model-b", resolved),
  ];
  const html = renderHtmlComparisonReport(runs, null);
  assert.match(html, /Unavailable/);
  assert.match(html, /no streaming deltas/);
});

test("html report escapes untrusted judge text", () => {
  const runs = [
    run("run-a", "openai", "model-a", resolved),
    run("run-b", "anthropic", "model-b", resolved),
  ];
  const html = renderHtmlComparisonReport(runs, evaluationFor(["run-a", "run-b"]));
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test("html report notes when no evaluation is attached", () => {
  const runs = [
    run("run-a", "openai", "model-a", resolved),
    run("run-b", "anthropic", "model-b", resolved),
  ];
  const html = renderHtmlComparisonReport(runs, null);
  assert.match(html, /No <code>llm-evaluation-\*\.json<\/code> artifact was found/);
});

test("html report flags orphan scores and runs without a score", () => {
  const runs = [
    run("run-a", "openai", "model-a", resolved),
    run("run-b", "anthropic", "model-b", resolved),
  ];
  // Evaluation references run-a (present) and run-x (absent); run-b has no score.
  const evaluation = evaluationFor(["run-a", "run-x"]);
  const html = renderHtmlComparisonReport(runs, evaluation);
  assert.match(html, /no longer present in this runs directory/);
  assert.match(html, /run-x/);
  assert.match(html, /Not evaluated by this judge run/);
});

test("html report surfaces contract drift as not strictly comparable", () => {
  const drifted = run("run-b", "anthropic", "model-b", resolved);
  drifted.contract.execution.reasoningEffort = "low";
  const html = renderHtmlComparisonReport([run("run-a", "openai", "model-a", resolved), drifted], null);
  assert.match(html, /Contract drift detected/);
  assert.match(html, /Not strictly comparable/);
});

test("html report renders a decision summary and per-candidate quality cards", () => {
  const runs = [
    run("run-a", "openai", "model-a", resolved, { e2eMs: available(120_000) }),
    run("run-b", "anthropic", "model-b", resolved, { e2eMs: available(300_000) }),
  ];
  const html = renderHtmlComparisonReport(runs, evaluationFor(["run-a", "run-b"]));
  // Decision summary derives the fastest resolved run and the top judged candidate.
  assert.match(html, /Decision summary/);
  assert.match(html, /Fastest deterministic pass/);
  assert.match(html, /Highest judged code quality/);
  // Per-candidate analysis cards replace the old score table.
  assert.match(html, /Per-candidate analysis/);
  assert.match(html, /quality-card/);
  assert.match(html, /Judge's comparative read/);
  // The judge's full rationale narrative is surfaced (escaped).
  assert.match(html, /Rationale for run-a/);
});

test("html report requires at least one run", () => {
  assert.throws(() => renderHtmlComparisonReport([], null), /at least one completed run/);
});

test("html report surfaces the code-change summary and labels missing diffs", () => {
  const directory = mkdtempSync(join(tmpdir(), "html-changes-"));
  try {
    const withDiff = run("run-a", "openai", "model-a", resolved);
    withDiff.artifacts.directory = directory;
    withDiff.artifacts.changes = join(directory, "changes.patch");
    writeFileSync(
      withDiff.artifacts.changes,
      "diff --git a/src/order.ts b/src/order.ts\n--- a/src/order.ts\n+++ b/src/order.ts\n+const first = 1;\n+const second = 2;\n-const removed = 0;\n",
      "utf8",
    );
    const withoutDiff = run("run-b", "anthropic", "model-b", resolved);
    const html = renderHtmlComparisonReport([withDiff, withoutDiff], null);
    assert.match(html, /Code \u0394/);
    assert.match(html, /1 file/);
    assert.match(html, /\+2/);
    assert.match(html, /\u22121/);
    assert.match(html, /Not captured/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("report surfaces deterministic artifact integrity a passing test command hides", () => {
  const root = mkdtempSync(join(tmpdir(), "report-artifact-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({
      name: "demo",
      main: "dist/store.js",
      devDependencies: { vitest: "^3.0.0" },
    }), "utf8");
    writeFileSync(join(root, "src", "store.ts"), "export class Store {}\n", "utf8");
    writeFileSync(join(root, "src", "store.test.ts"), "test('a', () => {});\n", "utf8");
    writeFileSync(join(root, "dist", "store.test.js"), "test('a', () => {});\n", "utf8");
    mkdirSync(join(root, "node_modules", "vitest"), { recursive: true });
    writeFileSync(join(root, "node_modules", "vitest", "package.json"), JSON.stringify({ version: "5.0.0-rc.1" }), "utf8");

    const inspected = run("run-a", "openai", "model-a", resolved);
    inspected.artifacts.workspace = root;
    const html = renderHtmlComparisonReport([inspected]);

    assert.match(html, /Code artifact inspection/);
    // The entry point the build never emits.
    assert.match(html, /points at <code>dist\/store\.js<\/code>/);
    // The installed package the manifest does not allow.
    assert.match(html, /declares <code>\^3\.0\.0<\/code> but <code>5\.0\.0-rc\.1<\/code> is installed \(a pre-release\)/);
    // The test file collected from build output, which double-counts assertions.
    assert.match(html, /collected from build output/);
    assert.match(html, /counts the same assertions twice/);
    assert.match(html, /Artifact integrity/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("report marks judge findings whose citation does not resolve to inspected code", () => {
  const root = mkdtempSync(join(tmpdir(), "report-findings-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "store.ts"), "const a = 1;\nconst b = 2;\n", "utf8");
    const inspected = run("run-a", "openai", "model-a", resolved);
    inspected.artifacts.workspace = root;

    const evaluation = evaluationFor(["run-a"]);
    evaluation.judge.promptVersion = "benchmark-judge-v3";
    evaluation.comparativeInsights = [
      { theme: "Input validation", observation: "Only one candidate rejects NaN.", candidates: ["openai/model-0/local-byok"] },
    ];
    evaluation.scores[0].correctness = 2;
    evaluation.scores[0].testAdequacy = 1;
    evaluation.scores[0].reviewedFiles = ["src/store.ts"];
    evaluation.scores[0].findings = [
      { file: "src/store.ts", line: 2, severity: "high", category: "correctness", claim: "Anchored claim", evidence: "const b = 2;", citationVerified: true },
      { file: "src/ghost.ts", line: 4, severity: "low", category: "api-design", claim: "Unanchored claim", evidence: "", citationVerified: false },
    ];

    const html = renderHtmlComparisonReport([inspected], evaluation);

    assert.match(html, /Code findings/);
    assert.match(html, /Anchored claim/);
    assert.match(html, /Unanchored claim/);
    assert.match(html, /1 citation could not be resolved/);
    assert.match(html, /badge warn">unverified/);
    // Cross-candidate divergences and the new dimensions are rendered.
    assert.match(html, /Cross-candidate divergences/);
    assert.match(html, /Only one candidate rejects NaN\./);
    assert.match(html, /Test adequacy/);
    assert.match(html, /Reviewed <strong>1<\/strong> of <strong>1<\/strong>/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("report warns when an attached evaluation predates full-source review", () => {
  const evaluation = evaluationFor(["run-a"]);
  evaluation.judge.promptVersion = "benchmark-judge-v2";
  const html = renderHtmlComparisonReport([run("run-a", "openai", "model-a", resolved)], evaluation);
  assert.match(html, /saw only a truncated diff, not the final source/);
});

function toolCall(toolName: string): BenchmarkRun["toolCalls"][number] {
  return {
    toolCallId: `${toolName}-1`,
    toolName,
    agentId: null,
    startedAt: null,
    completedAt: null,
    resultType: null,
    error: null,
  };
}

test("efficiency profile renders the captured timings the headline table omits", () => {
  const directory = mkdtempSync(join(tmpdir(), "efficiency-"));
  try {
    const html = renderHtmlComparisonReport(
      [run("r-1", "openai", "gpt-x", resolved)],
      null,
    );
    assert.match(html, /<h2>Agent efficiency profile<\/h2>/);
    for (const label of ["Time to first tool call", "Time to first edit", "Time to green test", "TPOT", "Cache write tokens", "Cache hit share", "Tokens per tool call", "Tool calls per edit"]) {
      assert.ok(html.includes(label), `expected the profile to render "${label}"`);
    }
    // 190,000 cache reads against 200,000 fresh input tokens.
    assert.ok(html.includes("48.7%"), "expected the cache hit share to be derived from both token counts");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a zero reported cost renders as unpriced rather than as the number zero", () => {
  const directory = mkdtempSync(join(tmpdir(), "unpriced-"));
  try {
    const html = renderHtmlComparisonReport(
      [run("r-1", "openai", "gpt-x", resolved)],
      null,
    );
    assert.ok(html.includes("Unpriced"), "expected a zero cost to be labeled, not rendered as 0");
    assert.match(html, /Zero is the absence of a price signal/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("per-tool-call ratios use the same edit detection as the metric and abstain without edits", () => {
  const directory = mkdtempSync(join(tmpdir(), "ratios-"));
  try {
    const withEdits = run("r-1", "openai", "gpt-x", resolved);
    withEdits.toolCalls = [toolCall("str_replace_editor"), toolCall("shell"), toolCall("read"), toolCall("shell")];
    const readOnly = run("r-2", "anthropic", "claude-x", resolved);
    readOnly.toolCalls = [toolCall("read"), toolCall("shell")];

    const html = renderHtmlComparisonReport([withEdits, readOnly], null);
    // 207,000 total tokens over 4 tool calls, and 4 tool calls for 1 edit.
    assert.ok(html.includes("51,750"), "expected tokens-per-tool-call to be derived");
    assert.ok(html.includes(">4.0<"), "expected tool-calls-per-edit to be derived");
    assert.match(html, /Requires at least one workspace-mutating tool call/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("efficiency metrics the stream never supported stay marked unavailable", () => {
  const directory = mkdtempSync(join(tmpdir(), "eff-unavailable-"));
  try {
    const html = renderHtmlComparisonReport(
      [run("r-1", "openai", "gpt-x", resolved, {
        timePerOutputTokenMs: unavailable("SDK did not emit assistant.usage.interTokenLatencyMs."),
        cacheReadTokens: unavailable("No cache telemetry."),
      })],
      null,
    );
    assert.match(html, /SDK did not emit assistant\.usage\.interTokenLatencyMs/);
    assert.match(html, /Requires both cache-read and input token counts/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});


function probeResult(
  checks: ReadonlyArray<{ id: string; status: "pass" | "weak" | "fail" | "error"; severity?: "required" | "advisory"; stderr?: string }>,
): ConformanceProbeResult {
  const results = checks.map((check) => ({
    id: check.id,
    description: `expectation ${check.id}`,
    command: `node probe.mjs ${check.id}`,
    severity: check.severity ?? ("required" as const),
    status: check.status,
    exitCode: check.status === "pass" ? 0 : check.status === "error" ? null : 1,
    timedOut: false,
    durationMs: 12,
    stdout: "",
    stderr: check.stderr ?? "",
    errorMessage: check.status === "error" ? "spawn failed" : null,
  }));
  const required = results.filter((check) => check.severity === "required");
  const conclusive = required.length > 0 && required.every((check) => check.status !== "error");
  return {
    available: true,
    description: "Task-owned behavioural checks.",
    startedAt: "2026-08-20T03:41:00.000Z",
    completedAt: "2026-08-20T03:41:09.000Z",
    durationMs: 9_000,
    setup: null,
    checks: results,
    totals: {
      total: results.length,
      passed: results.filter((check) => check.status === "pass").length,
      weak: results.filter((check) => check.status === "weak").length,
      failed: results.filter((check) => check.status === "fail").length,
      errored: results.filter((check) => check.status === "error").length,
    },
    conformant: conclusive ? required.every((check) => check.status === "pass") : null,
  };
}

function probed(base: BenchmarkRun, probe: ConformanceProbeResult): BenchmarkRun {
  return { ...base, conformance: probe };
}

test("conformance matrix renders one row per check and a verdict per candidate", () => {
  const html = renderHtmlComparisonReport(
    [
      probed(run("run-a", "openai", "model-a", resolved), probeResult([
        { id: "entry-resolves", status: "pass" },
        { id: "status-machine", status: "pass" },
      ])),
      probed(run("run-b", "openai", "model-a", resolved), probeResult([
        { id: "entry-resolves", status: "pass" },
        { id: "status-machine", status: "fail" },
      ])),
    ],
    null,
  );
  assert.match(html, /Conformance probe/);
  assert.match(html, /entry-resolves/);
  assert.match(html, /status-machine/);
  assert.match(html, /Non-conformant/);
  assert.match(html, /Conformant/);
});

test("a green run that fails a required expectation is reported as a divergence", () => {
  const html = renderHtmlComparisonReport(
    [
      probed(run("run-a", "openai", "model-a", resolved), probeResult([{ id: "entry-resolves", status: "fail" }])),
      probed(run("run-b", "openai", "model-a", resolved), probeResult([{ id: "entry-resolves", status: "pass" }])),
    ],
    null,
  );
  assert.match(html, /Validation and conformance disagree/i);
  // The recorded outcome is anchored to the validation command and must not be
  // silently rewritten by the probe.
  assert.match(html, /outcome stays/i);
});

test("a failed run that also fails its probe is not reported as a divergence", () => {
  const html = renderHtmlComparisonReport(
    [
      probed(run("run-a", "openai", "model-a", failed), probeResult([{ id: "entry-resolves", status: "fail" }])),
      probed(run("run-b", "openai", "model-a", resolved), probeResult([{ id: "entry-resolves", status: "pass" }])),
    ],
    null,
  );
  assert.doesNotMatch(html, /Validation and conformance disagree/i);
});

test("an advisory failure records a weakness without withholding the conformance verdict", () => {
  const html = renderHtmlComparisonReport(
    [
      probed(run("run-a", "openai", "model-a", resolved), probeResult([
        { id: "entry-resolves", status: "pass" },
        { id: "no-state-leak", status: "weak", severity: "advisory", stderr: "returned object aliases internal state" },
      ])),
      probed(run("run-b", "openai", "model-a", resolved), probeResult([{ id: "entry-resolves", status: "pass" }])),
    ],
    null,
  );
  assert.match(html, /Weak/);
  assert.doesNotMatch(html, /Non-conformant/);
  // The weakness is still surfaced with its evidence rather than swallowed.
  assert.match(html, /returned object aliases internal state/);
});

test("runs recorded before probes existed read as not probed rather than as passing", () => {
  const html = renderHtmlComparisonReport(
    [
      probed(run("run-a", "openai", "model-a", resolved), probeResult([{ id: "entry-resolves", status: "pass" }])),
      run("run-b", "openai", "model-a", resolved),
    ],
    null,
  );
  assert.match(html, /Not probed/);
});

