import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { immutableContractHash } from "../src/contract.js";
import { evidenceFromRuns, parseReportEvidence, selectReportCells, taskTypeAnalysis, attemptFromRun, evidenceHash } from "../src/evidence.js";
import { fixtureConfig, fixtureRun } from "./fixtures/revamp.js";
import { providerTerminal } from "../src/provider-stream.js";
import { renderEvidenceReport } from "../src/report-ui.js";
import { extractModelCalls } from "../src/metrics.js";
import { event } from "./fixtures/events.js";

test("usage adapter preserves observed turns, tools and cache independently of SDK/HTTP counters and acceptance", () => {
  const root = mkdtempSync(join(tmpdir(), "benchmark-usage-evidence-"));
  try {
    const run = fixtureRun("usage", fixtureConfig(), "ungraded");
    run.artifacts.normalizedEvents = join(root, "events.ndjson");
    writeFileSync(run.artifacts.normalizedEvents, [
      ...Array.from({ length: 3 }, () => ({ eventType: "assistant.turn_start", data: { prompt: "PRIVATE-TURN-TEXT" } })),
      { eventType: "assistant.message", data: { content: "PRIVATE-ANSWER" } },
    ].map(value => JSON.stringify(value)).join("\n"));
    run.modelCalls = extractModelCalls(Array.from({ length: 4 }, (_, sequence) => event(sequence, "assistant.usage", run.startedAt, { inputTokens: 10, outputTokens: 5 })));
    run.toolCalls = [{ toolCallId: "tool-1", toolName: "shell", agentId: null, startedAt: run.startedAt,
      completedAt: null, resultType: null, error: null }];
    run.usageMetrics = { modelMetrics: { requests: { count: 999 } }, turns: 999 };
    run.requestAccounting!.physicalRequests = 5;
    run.metrics.cacheReadTokens = { status: "available", value: 70 };
    run.metrics.cacheWriteTokens = { status: "unavailable", value: null };
    run.validation!.exitCode = 1;
    const evidence = evidenceFromRuns([run]), attempt = evidence.attempts[0];
    assert.equal(attempt.acceptance, "ungraded"); assert.equal(attempt.validation, "fail");
    assert.equal(attempt.validationExitCode, 1); assert.equal(attempt.validationTimedOut, false);
    assert.equal(attempt.metrics.agentTurns, 3);
    assert.equal(attempt.metrics.modelUsageRecords, 4); assert.equal(attempt.metrics.physicalRequests, 5);
    assert.equal(attempt.metrics.toolCalls, 1);
    assert.equal(attempt.metrics.cacheReadTokens, 70); assert.equal(attempt.metrics.cacheWriteTokens, null);
    assert.doesNotMatch(JSON.stringify(evidence), /PRIVATE-TURN-TEXT|PRIVATE-ANSWER/);
    const old = structuredClone(evidence);
    delete old.attempts[0].metrics.agentTurns; delete old.attempts[0].metrics.toolCalls;
    delete old.attempts[0].metrics.cacheReadTokens; delete old.attempts[0].metrics.cacheWriteTokens;
    delete old.attempts[0].validationExitCode; delete old.attempts[0].validationTimedOut;
    assert.equal(parseReportEvidence(old).attempts[0].metrics.agentTurns, undefined);
    run.artifacts.normalizedEvents = join(root, "missing.ndjson");
    assert.equal(attemptFromRun(run, "task", "candidate").metrics.agentTurns, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("turn counts use the bounded complete archive, never a truncated replay or absent stream", () => {
  const root = mkdtempSync(join(tmpdir(), "benchmark-usage-bounds-"));
  try {
    const run = fixtureRun("turns", fixtureConfig(), "ungraded");
    run.artifacts.normalizedEvents = join(root, "events.ndjson");
    writeFileSync(run.artifacts.normalizedEvents, Array.from({ length: 1005 },
      () => JSON.stringify({ eventType: "assistant.turn_start", data: {} })).join("\n"));
    const attempt = attemptFromRun(run, "task", "candidate");
    assert.equal(attempt.replay.length, 1000); assert.equal(attempt.replayState, "truncated");
    assert.equal(attempt.metrics.agentTurns, 1005);
    writeFileSync(run.artifacts.normalizedEvents, Buffer.alloc(16 * 1024 * 1024 + 1, 32));
    const oversized = attemptFromRun(run, "task", "candidate");
    assert.equal(oversized.metrics.agentTurns, null); assert.equal(oversized.replayState, "truncated");
    assert.equal(oversized.replay.length, 0);
    writeFileSync(run.artifacts.normalizedEvents, "invalid events");
    assert.throws(() => attemptFromRun(run, "task", "candidate"), /JSON/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("latest clean content FAIL replaces PASS; newer interruption does not", () => {
  const pass = fixtureRun("old-pass"), fail = fixtureRun("new-fail", fixtureConfig(), "fail"), interrupted = fixtureRun("interrupted");
  fail.completedAt = "2026-10-08T01:00:00.000Z";
  interrupted.completedAt = "2026-10-08T02:00:00.000Z";
  interrupted.executionStatus = "interrupted"; interrupted.runnerError = "ambiguous timeout";
  const [cell] = selectReportCells(evidenceFromRuns([pass, fail, interrupted]));
  assert.equal(cell.selected?.id, "new-fail"); assert.equal(cell.status, "fail"); assert.equal(cell.attempts.length, 3);
});

test("metadata evidence retains metered failed terminals without changing interruption selection or inventing old usage", () => {
  const run = fixtureRun("metered-interruption");
  run.executionStatus = "interrupted"; run.runnerError = "provider incomplete";
  const terminal = providerTerminal({ type: "response.incomplete", response: { status: "incomplete", output: [],
    incomplete_details: { reason: "max_output_tokens" }, error: { code: "PRIVATE_CODE", message: "PRIVATE_BODY" },
    usage: { input_tokens: 100, output_tokens: 32, total_tokens: 132, output_tokens_details: { reasoning_tokens: 30 } } } }, true)!;
  run.requestAccounting = { physicalRequests: 1, reservedTokens: 2000, ambiguousRequests: 1, rejectedRequests: 0,
    providerTerminals: [{ request: 1, terminal }] };
  const evidence = evidenceFromRuns([run]), attempt = evidence.attempts[0];
  assert.equal(selectReportCells(evidence)[0].status, "interrupted");
  assert.equal(attempt.accounting.providerTerminals?.[0].terminal.usage?.outputTokens, 32);
  assert.equal(attempt.accounting.providerTerminals?.[0].terminal.errorCode, "other");
  assert.doesNotMatch(JSON.stringify(evidence), /PRIVATE_CODE|PRIVATE_BODY/);
  const html = renderEvidenceReport(evidence);
  assert.match(html, /providerTerminals/); assert.match(html, /Ambiguous execution does not imply missing metering/);
  assert.doesNotMatch(html, /PRIVATE_CODE|PRIVATE_BODY/);
  assert.throws(() => evidenceFromRuns([{ ...run, requestAccounting: { ...run.requestAccounting,
    providerTerminals: [{ request: 2, terminal }] } }]), /dispatched physical requests/);
  assert.throws(() => evidenceFromRuns([{ ...run, requestAccounting: { ...run.requestAccounting,
    providerTerminals: [{ request: 1, terminal }, { request: 1, terminal }] } }]), /unique/);
  const legacy = fixtureRun("old-interruption");
  legacy.executionStatus = "interrupted"; legacy.runnerError = "unknown old provider error";
  assert.equal(evidenceFromRuns([legacy]).attempts[0].accounting.providerTerminals, undefined);
});
test("latest selection compares instants rather than lexical timezone strings", () => {
  const pass = fixtureRun("earlier"), fail = fixtureRun("later", fixtureConfig(), "fail");
  pass.completedAt = "2026-10-08T02:30:00+02:00"; fail.completedAt = "2026-10-08T00:40:00Z";
  assert.equal(selectReportCells(evidenceFromRuns([pass, fail]))[0].selected?.id, "later");
});
test("advisory errors do not replace proven required content verdicts; malformed grade counts fail", () => {
  const run = fixtureRun("advisory-error");
  run.conformance!.checks.push({ ...run.conformance!.checks[0], id: "advisory", severity: "advisory", status: "error", exitCode: null });
  const evidence = evidenceFromRuns([run]);
  assert.equal(evidence.attempts[0].acceptance, "pass"); assert.equal(evidence.attempts[0].checkErrors, 1);
  assert.throws(() => parseReportEvidence({ ...evidence, attempts: [{ ...evidence.attempts[0], acceptance: "fail", requiredFailed: 0 }] }), /contradicts/);
});
test("matched analysis excludes different recorded protocol/auth/resource signatures", () => {
  const a = fixtureRun("a", fixtureConfig("workspace", "same-task", "a"));
  const b = fixtureRun("b", fixtureConfig("workspace", "same-task", "b"));
  b.contract.foundryProvider!.wireApi = "completions"; b.contractHash = immutableContractHash(b.contract);
  assert.ok(taskTypeAnalysis(evidenceFromRuns([a, b])).every((r) => r.samples === 0));
});
test("declared missing, interrupted and ungraded cells are not PASS", () => {
  const evidence = evidenceFromRuns([fixtureRun("ungraded", fixtureConfig(), "ungraded")]);
  evidence.candidates.push({ id: "not-run", provider: "openai", model: "not-run" });
  assert.deepEqual(selectReportCells(evidence).map((c) => c.status), ["ungraded", "missing"]);
  evidence.attempts[0].execution = "interrupted";
  assert.equal(selectReportCells(evidence)[0].status, "interrupted");
});
test("normalized phases distinguish recorded required checks, pending checks and candidate-only finalization", () => {
  assert.equal(attemptFromRun(fixtureRun("required-pass"), "task", "candidate").phase, "graded");
  const absent = fixtureRun("no-grader", fixtureConfig(), "ungraded");
  assert.equal(attemptFromRun(absent, "task", "candidate").phase, "finalized");
  absent.contract.task.conformanceProbe = { checks: [{ id: "R1", description: "Required control", command: "node --version" }] };
  absent.contractHash = immutableContractHash(absent.contract);
  const pending = attemptFromRun(absent, "task", "candidate");
  assert.equal(pending.phase, "grading-pending"); assert.equal(pending.acceptance, "ungraded");
  assert.equal(pending.checkErrors, 0); assert.equal(pending.outcome, "resolved");
  const advisory = fixtureRun("advisory-only");
  advisory.conformance!.checks[0].severity = "advisory";
  assert.equal(attemptFromRun(advisory, "task", "candidate").phase, "finalized");
  assert.equal(attemptFromRun(advisory, "task", "candidate").acceptance, "ungraded");
  absent.executionStatus = "interrupted"; absent.runnerError = "fixture interruption";
  assert.equal(attemptFromRun(absent, "task", "candidate").phase, "execution");
});
test("changed task/execution/round/runtime cohorts cannot collapse into comparable cells", () => {
  const a = fixtureRun("a"), b = fixtureRun("b");
  b.contract.rounds = [{ prompt: "Changed follow-up." }]; b.contractHash = immutableContractHash(b.contract);
  const evidence = evidenceFromRuns([a, b]);
  assert.equal(evidence.tasks.length, 2); assert.equal(selectReportCells(evidence).length, 2);
});
test("adapter rejects unknown versions, duplicates, bad hashes and invalid selection", () => {
  const run = fixtureRun("a");
  assert.throws(() => evidenceFromRuns([{ ...run, contractHash: "b".repeat(64) }]), /hash mismatch/);
  const evidence = evidenceFromRuns([run]);
  assert.throws(() => parseReportEvidence({ ...evidence, schemaVersion: 999 }));
  assert.throws(() => parseReportEvidence({ ...evidence, attempts: [...evidence.attempts, evidence.attempts[0]] }), /Duplicate/);
  assert.throws(() => parseReportEvidence({ ...evidence, selected: { nonexistent: "a" } }), /selection/);
});
test("grades bind contract, saved workspace and evaluator policy without model-specific exceptions", () => {
  const run = fixtureRun("a"); run.workspaceHash = "f".repeat(64);
  const grade = {
    schemaVersion: 1 as const, runId: "a", contractHash: run.contractHash, workspaceHash: run.workspaceHash,
    policyHash: evidenceHash({ policy: "uniform" }), evaluatorVersion: "1", calibrated: true,
    checks: [{ id: "required", requirementId: "R1", category: "semantic", expectedType: "text",
      severity: "required" as const, status: "fail" as const }], createdAt: run.completedAt,
  };
  assert.equal(attemptFromRun(run, "task", "model", 0, grade).acceptance, "fail");
  assert.throws(() => attemptFromRun(run, "task", "model", 0, { ...grade, workspaceHash: "c".repeat(64) }), /bind/);
  const evidence = evidenceFromRuns([run]);
  evidence.tasks[0].evaluatorPolicyHash = "a".repeat(64);
  evidence.attempts[0].policyHash = "b".repeat(64);
  assert.throws(() => parseReportEvidence(evidence), /policy mismatch/);
});
test("generic generated 280-cell fixture retains denominators and bounded evidence size", () => {
  const runs = Array.from({ length: 40 }, (_, task) => Array.from({ length: 7 }, (_, candidate) =>
    fixtureRun(`t${task}-c${candidate}`, fixtureConfig("workspace", `task-${task}`, `candidate-${candidate}`), (task + candidate) % 5 ? "pass" : "fail"))).flat();
  const evidence = evidenceFromRuns(runs);
  assert.equal(evidence.tasks.length, 40); assert.equal(evidence.candidates.length, 7);
  assert.equal(selectReportCells(evidence).length, 280);
  assert.ok(taskTypeAnalysis(evidence).every((a) => a.matchedTasks === 40 && a.samples === 40));
  assert.ok(Buffer.byteLength(JSON.stringify(evidence)) < 1024 * 1024);
  evidence.attempts.pop();
  assert.ok(taskTypeAnalysis(evidence).every((a) => a.matchedTasks === 39));
});
