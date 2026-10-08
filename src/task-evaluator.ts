import { z } from "zod";
import { gradeSchema, evidenceHash, type EvaluatorGrade } from "./evidence.js";
import { collectSnapshot, snapshotHash } from "./controlled-worker.js";
import { runValidation } from "./validation.js";
import type { BenchmarkRun } from "./types.js";

export const evaluatorPolicySchema = z.object({
  schemaVersion: z.literal(1), version: z.string().min(1),
  setupCommand: z.string().optional(), timeoutMs: z.number().int().positive(),
  graderInputsHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  deadlineMs: z.number().int().positive().optional(),
  checks: z.array(z.object({
    id: z.string().min(1), requirementId: z.string().min(1), category: z.string().min(1),
    expectedType: z.string().min(1), severity: z.enum(["required", "advisory"]), command: z.string().min(1),
    failureExitCodes: z.array(z.number().int().min(1).max(125)).min(1).optional(),
  }).strict()).min(1),
}).strict();
export type EvaluatorPolicy = z.infer<typeof evaluatorPolicySchema>;
export const calibrationSchema = z.object({
  schemaVersion: z.literal(1), policyHash: z.string().regex(/^[a-f0-9]{64}$/),
  calibrated: z.boolean(),
  references: z.array(z.object({
    id: z.string(), kind: z.enum(["positive", "negative", "equivalent"]),
    workspaceHash: z.string().regex(/^[a-f0-9]{64}$/),
    expected: z.record(z.string(), z.enum(["pass", "fail"])),
    observed: z.record(z.string(), z.enum(["pass", "fail", "error"])),
  }).strict()),
}).strict();
export type EvaluatorCalibration = z.infer<typeof calibrationSchema>;

export function parseEvaluatorPolicy(input: unknown): EvaluatorPolicy {
  const policy = evaluatorPolicySchema.parse(input);
  if (new Set(policy.checks.map((c) => c.id)).size !== policy.checks.length) throw new TypeError("Duplicate evaluator check IDs.");
  if (!policy.checks.some((c) => c.severity === "required")) throw new TypeError("An acceptance evaluator needs at least one public required check.");
  return policy;
}

export function verifyCalibration(policy: EvaluatorPolicy, input: unknown): EvaluatorCalibration {
  const calibration = calibrationSchema.parse(input);
  if (new Set(calibration.references.map((r) => r.id)).size !== calibration.references.length) throw new TypeError("Duplicate calibration reference IDs.");
  if (calibration.policyHash !== evidenceHash(policy)) throw new TypeError("Calibration policy hash mismatch.");
  const required = policy.checks.filter((c) => c.severity === "required");
  const calibrated = required.every((check) =>
    calibration.references.some((r) => r.kind === "positive" && r.expected[check.id] === "pass")
    && calibration.references.some((r) => r.kind === "equivalent" && r.expected[check.id] === "pass")
    && calibration.references.some((r) => r.kind === "negative" && r.expected[check.id] === "fail"))
    && calibration.references.every((r) => Object.keys(r.expected).length === policy.checks.length
      && policy.checks.every((c) => r.expected[c.id] && r.expected[c.id] === r.observed[c.id]));
  if (calibration.calibrated !== calibrated) throw new TypeError("Calibration flag contradicts the recorded reference controls.");
  return calibration;
}

async function evaluateChecks(policy: EvaluatorPolicy, workspace: string, execute: typeof runValidation, deadlineAt?: number) {
  const deadline = Math.min(deadlineAt ?? Infinity, Date.now() + (policy.deadlineMs ?? policy.timeoutMs * (policy.checks.length + 1)));
  const timeout = () => {
    if (Date.now() >= deadline) throw new Error("Task evaluator absolute deadline exceeded; retained output can be finalized without inference.");
    return Math.max(1, Math.min(policy.timeoutMs, deadline - Date.now()));
  };
  const setup = policy.setupCommand ? await execute(policy.setupCommand, workspace, timeout()) : null;
  const setupFailed = setup && (setup.exitCode !== 0 || setup.timedOut || setup.errorMessage);
  const checks = [];
  for (const check of policy.checks) {
    const result = setupFailed ? null : await execute(check.command, workspace, timeout());
    const status = !result || result.exitCode === null || result.errorMessage || result.timedOut ? "error"
      : result.exitCode === 0 ? "pass" : !(check.failureExitCodes ?? [1]).includes(result.exitCode) ? "error"
      : check.severity === "advisory" ? "weak" : "fail";
    checks.push({ id: check.id, requirementId: check.requirementId, category: check.category, expectedType: check.expectedType, severity: check.severity, status } as const);
  }
  return checks;
}

export async function gradeSavedRun(
  run: BenchmarkRun, policyInput: unknown, workspaceHash: string, calibrationInput?: unknown, execute: typeof runValidation = runValidation,
  graderInputsHash?: string,
  deadlineAt?: number,
): Promise<EvaluatorGrade> {
  const policy = parseEvaluatorPolicy(policyInput);
  if (policy.graderInputsHash !== graderInputsHash) throw new TypeError("Private grader input binding mismatch.");
  if (!run.artifacts.workspace || run.workspaceHash !== workspaceHash) throw new TypeError("Saved run must bind the exact graded workspace.");
  if (snapshotHash(collectSnapshot(run.artifacts.workspace, 100000, 512 * 1024 * 1024)) !== workspaceHash) throw new TypeError("Graded workspace bytes changed after the saved output binding.");
  const calibration = calibrationInput ? verifyCalibration(policy, calibrationInput) : null;
  return gradeSchema.parse({
    schemaVersion: 1, runId: run.runId, contractHash: run.contractHash, workspaceHash,
    policyHash: evidenceHash(policy), evaluatorVersion: policy.version,
    checks: await evaluateChecks(policy, run.artifacts.workspace, execute, deadlineAt),
    calibrated: calibration?.calibrated ?? false, createdAt: new Date().toISOString(),
  });
}

export async function calibrateEvaluator(
  policyInput: unknown,
  references: readonly { id: string; kind: "positive" | "negative" | "equivalent"; workspace: string; expected: Record<string, "pass" | "fail"> }[],
  execute: typeof runValidation = runValidation,
  graderInputsHash?: string,
): Promise<EvaluatorCalibration> {
  const policy = parseEvaluatorPolicy(policyInput);
  if (policy.graderInputsHash !== graderInputsHash) throw new TypeError("Private grader input binding mismatch.");
  const records = [];
  for (const reference of references) {
    const workspaceHash = snapshotHash(collectSnapshot(reference.workspace, 10000, 64 * 1024 * 1024));
    const checks = await evaluateChecks(policy, reference.workspace, execute);
    records.push({
      id: reference.id, kind: reference.kind, expected: reference.expected, workspaceHash,
      observed: Object.fromEntries(checks.map((c) => [c.id, c.status === "weak" ? "fail" : c.status])),
    });
  }
  const base = { schemaVersion: 1 as const, policyHash: evidenceHash(policy), calibrated: false, references: records };
  try { return verifyCalibration(policy, { ...base, calibrated: true }); }
  catch (error) {
    if (error instanceof TypeError && error.message === "Calibration flag contradicts the recorded reference controls.") return verifyCalibration(policy, base);
    throw error;
  }
}
