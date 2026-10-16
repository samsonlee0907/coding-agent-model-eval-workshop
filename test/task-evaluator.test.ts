import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calibrateEvaluator, gradeSavedRun, verifyCalibration, parseEvaluatorPolicy } from "../src/task-evaluator.js";
import { evidenceHash } from "../src/evidence.js";
import { collectSnapshot, snapshotHash } from "../src/controlled-worker.js";
import { fixtureConfig, fixtureRun } from "./fixtures/revamp.js";
import type { ValidationResult } from "../src/types.js";
import { runValidation } from "../src/validation.js";

const policy = { schemaVersion: 1, version: "uniform-v1", timeoutMs: 1000, checks: [
  { id: "requirement", requirementId: "R1", category: "semantic", expectedType: "text", severity: "required", command: "uniform-private-check" },
  { id: "style", requirementId: "A1", category: "style", expectedType: "text", severity: "advisory", command: "advisory-check" },
] };
const result = (code: number | null, errorMessage: string | null = null): ValidationResult => ({
  command: "fixture", startedAt: "2026-10-08T00:00:00Z", completedAt: "2026-10-08T00:00:00Z", durationMs: 1,
  exitCode: code, timedOut: false, errorMessage, stdout: "", stderr: "",
});
test("uniform evaluator reports all required/advisory/error checks and binds exact workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "benchmark-grading-"));
  try {
    writeFileSync(join(root, "result.txt"), "valid output");
    const run = fixtureRun("a", fixtureConfig(root)); run.workspaceHash = snapshotHash(collectSnapshot(root, 100, 10000));
    const grade = await gradeSavedRun(run, policy, run.workspaceHash, undefined, async (cmd) => result(cmd === "advisory-check" ? 1 : 0));
    assert.deepEqual(grade.checks.map((c) => c.status), ["pass", "weak"]); assert.equal(grade.policyHash, evidenceHash(policy));
    assert.equal(grade.calibrated, false);
    await assert.rejects(() => gradeSavedRun(run, policy, "c".repeat(64)), /exact graded workspace/);
    const errors = await gradeSavedRun(run, { ...policy, setupCommand: "setup" }, run.workspaceHash, undefined, async () => result(null, "setup unavailable"));
    assert.deepEqual(errors.checks.map((c) => c.status), ["error", "error"]);
    const malformed = await gradeSavedRun(run, policy, run.workspaceHash, undefined, async () => result(127));
    assert.deepEqual(malformed.checks.map((c) => c.status), ["error", "error"]);
    writeFileSync(join(root, "result.txt"), "mutated after capture");
    await assert.rejects(() => gradeSavedRun(run, policy, run.workspaceHash!), /bytes changed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("evaluator checks are sequential, asset bindings and absolute deadlines fail closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "benchmark-grader-order-"));
  try {
    writeFileSync(join(root, "result.txt"), "fixture");
    const run = fixtureRun("a", fixtureConfig(root)); run.workspaceHash = snapshotHash(collectSnapshot(root, 100, 10000));
    let active = 0;
    await gradeSavedRun(run, policy, run.workspaceHash, undefined, async () => {
      assert.equal(active++, 0); await Promise.resolve(); active--; return result(0);
    });
    await assert.rejects(() => gradeSavedRun(run, { ...policy, graderInputsHash: "a".repeat(64) }, run.workspaceHash!), /input binding/);
    await assert.rejects(() => gradeSavedRun(run, policy, run.workspaceHash!, undefined, async () => result(0), undefined, 1), /deadline/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("calibration requires positives, intentional negatives and equivalent-valid representations", async () => {
  const root = mkdtempSync(join(tmpdir(), "benchmark-calibration-"));
  try {
    writeFileSync(join(root, "reference.txt"), "deidentified fixture");
    const references = ["positive", "negative", "equivalent"].map((kind) => ({
      id: kind, kind: kind as "positive" | "negative" | "equivalent", workspace: root,
      expected: { requirement: kind === "negative" ? "fail" as const : "pass" as const, style: "pass" as const },
    }));
    let referenceIndex = 0;
    const calibration = await calibrateEvaluator(policy, references, async (command) => {
      const reference = referenceIndex;
      if (command === "advisory-check") referenceIndex++;
      return result(command === "uniform-private-check" && reference === 1 ? 1 : 0);
    });
    assert.equal(calibration.calibrated, true);
    assert.equal((await calibrateEvaluator(policy, references.slice(0, 1), async () => result(0))).calibrated, false);
    assert.throws(() => verifyCalibration(parseEvaluatorPolicy({ ...policy, version: "changed" }), calibration), /policy hash/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("grading and calibration use compact owned copies, preserve original bytes and clean up after errors", async () => {
  const root = mkdtempSync(join(tmpdir(), "bt-long-grader-"));
  const publicPolicy = JSON.parse(readFileSync(join("examples", "custom-campaign", "json-evaluator.json"), "utf8"));
  const gradingPolicy = { ...publicPolicy,
    setupCommand: 'node -e "require(\'node:fs\').writeFileSync(\'grader-only.txt\',\'transient\')"' };
  const workingCopies: string[] = [];
  const execute: typeof runValidation = async (command, cwd, timeout) => {
    workingCopies.push(cwd); assert.ok(cwd.length < 240); assert.ok(!cwd.startsWith(root));
    return runValidation(command, cwd, timeout);
  };
  try {
    const referenceRoot = join(root, "long".repeat(40), "reference".repeat(10));
    const references = ["positive", "negative", "equivalent"].map((kind) => {
      const workspace = join(referenceRoot, kind); mkdirSync(workspace, { recursive: true });
      writeFileSync(join(workspace, "answer.json"), kind === "negative" ? '{"sum":0}\r\n'
        : kind === "equivalent" ? '{ "sum": 16, "extra": true }\n' : '{"sum":16}\r\n');
      return { id: kind, kind: kind as "positive" | "negative" | "equivalent", workspace,
        expected: { "public-sum": kind === "negative" ? "fail" as const : "pass" as const } };
    });
    const hashes = references.map((ref) => snapshotHash(collectSnapshot(ref.workspace, 100, 10000)));
    const calibration = await calibrateEvaluator(gradingPolicy, references, execute);
    assert.equal(calibration.calibrated, true);
    const run = fixtureRun("long", fixtureConfig(references[0].workspace)); run.workspaceHash = hashes[0];
    const grade = await gradeSavedRun(run, gradingPolicy, run.workspaceHash, calibration, execute);
    assert.equal(grade.checks[0].status, "pass"); assert.equal(grade.workspaceHash, hashes[0]);
    assert.ok(workingCopies.length > 0); assert.ok(workingCopies.every((cwd) => !existsSync(cwd)));
    assert.deepEqual(references.map((ref) => snapshotHash(collectSnapshot(ref.workspace, 100, 10000))), hashes);
    assert.equal(readFileSync(join(references[0].workspace, "answer.json"), "utf8"), '{"sum":16}\r\n');
    const failedCalibration = await calibrateEvaluator({ ...publicPolicy, setupCommand: "node\u0000" }, references, execute);
    assert.equal(failedCalibration.calibrated, false);
    assert.deepEqual(failedCalibration.references[0].diagnostics?.["public-sum"], {
      stage: "setup", exitCode: null, timedOut: false, failures: [{ phase: "spawn", code: "ERR_INVALID_ARG_VALUE" }],
    });
    assert.ok(workingCopies.every((cwd) => !existsSync(cwd)));
    await assert.rejects(() => gradeSavedRun(run, publicPolicy, run.workspaceHash!, undefined, async (_cmd, cwd) => {
      workingCopies.push(cwd); throw new Error("explicit executor failure");
    }), /explicit executor failure/);
    assert.ok(workingCopies.every((cwd) => !existsSync(cwd)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
