import assert from "node:assert/strict";
import test from "node:test";
import { immutableContractHash } from "../src/contract.js";
import { evidenceFromRuns, parseReportEvidence, selectReportCells, taskTypeAnalysis, attemptFromRun, evidenceHash } from "../src/evidence.js";
import { fixtureConfig, fixtureRun } from "./fixtures/revamp.js";

test("latest clean content FAIL replaces PASS; newer interruption does not", () => {
  const pass = fixtureRun("old-pass"), fail = fixtureRun("new-fail", fixtureConfig(), "fail"), interrupted = fixtureRun("interrupted");
  fail.completedAt = "2026-10-08T01:00:00.000Z";
  interrupted.completedAt = "2026-10-08T02:00:00.000Z";
  interrupted.executionStatus = "interrupted"; interrupted.runnerError = "ambiguous timeout";
  const [cell] = selectReportCells(evidenceFromRuns([pass, fail, interrupted]));
  assert.equal(cell.selected?.id, "new-fail"); assert.equal(cell.status, "fail"); assert.equal(cell.attempts.length, 3);
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
