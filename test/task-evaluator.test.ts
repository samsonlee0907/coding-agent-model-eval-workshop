import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calibrateEvaluator, gradeSavedRun, verifyCalibration, parseEvaluatorPolicy } from "../src/task-evaluator.js";
import { evidenceHash } from "../src/evidence.js";
import { collectSnapshot, snapshotHash } from "../src/controlled-worker.js";
import { fixtureConfig, fixtureRun } from "./fixtures/revamp.js";
import type { ValidationResult } from "../src/types.js";

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
