import { createHash } from "node:crypto";
import { z } from "zod";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { immutableContractHash, comparableBaselineSignature, compareRunContractSet } from "./contract.js";
import { candidateKey } from "./pricing.js";
import type { BenchmarkRun, RunContract } from "./types.js";

export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().min(1).max(500);
const count = z.number().int().nonnegative();
const optionalNumber = z.number().finite().nonnegative().nullable();
const date = z.string().datetime({ offset: true });
const conformanceEvidenceSchema = z.object({
  available: z.boolean(), conformant: z.boolean().nullable(),
  checks: z.array(z.object({ id, severity: z.enum(["required", "advisory"]), status: z.enum(["pass", "fail", "weak", "error"]) }).passthrough()),
}).passthrough();
const checkSchema = z.object({
  id, requirementId: id, category: id, expectedType: id,
  severity: z.enum(["required", "advisory"]),
  status: z.enum(["pass", "fail", "weak", "error"]),
}).strict();
export const gradeSchema = z.object({
  schemaVersion: z.literal(1), runId: id, contractHash: sha256Schema,
  workspaceHash: sha256Schema, policyHash: sha256Schema, evaluatorVersion: id,
  checks: z.array(checkSchema).min(1), calibrated: z.boolean(), createdAt: date,
}).strict().superRefine((grade, ctx) => {
  if (new Set(grade.checks.map((c) => c.id)).size !== grade.checks.length) ctx.addIssue({ code: "custom", message: "Duplicate grade check IDs." });
  if (grade.checks.some((c) => c.severity === "required" && c.status === "weak")) ctx.addIssue({ code: "custom", message: "Required checks cannot have advisory WEAK status." });
});
export type EvaluatorGrade = z.infer<typeof gradeSchema>;

const taskSchema = z.object({
  id, taskId: id, version: id, title: id, taskType: id.optional(), tags: z.array(id),
  taskHash: sha256Schema, cohortHash: sha256Schema, evaluatorPolicyHash: sha256Schema.optional(),
}).strict();
const candidateSchema = z.object({ id, provider: id, model: id, deployment: id.optional() }).strict();
const attemptSchema = z.object({
  id, task: id, candidate: id, repeat: count,
  contractHash: sha256Schema, promptHash: sha256Schema, roundsHash: sha256Schema,
  cohortHash: sha256Schema, workspaceHash: sha256Schema.nullable(),
  comparisonHash: sha256Schema.nullable().optional(),
  startedAt: date, completedAt: date,
  execution: z.enum(["completed", "interrupted", "error"]),
  phase: id, validation: z.enum(["pass", "fail", "error", "unavailable"]),
  acceptance: z.enum(["pass", "fail", "error", "ungraded"]),
  requiredPassed: count, requiredFailed: count, advisoryFailed: count, checkErrors: count,
  requiredErrors: count.optional(),
  policyHash: sha256Schema.nullable(), evaluatorVersion: id.nullable(), calibrated: z.boolean().nullable(),
  metrics: z.object({
    wallMs: optionalNumber, inputTokens: optionalNumber, outputTokens: optionalNumber,
    recordedCost: optionalNumber, recordedUsd: optionalNumber,
    modelUsageRecords: count, physicalRequests: optionalNumber,
  }).strict(),
  accounting: z.object({
    reservedTokens: optionalNumber, ambiguousRequests: optionalNumber, rejectedRequests: optionalNumber,
  }).strict(),
  reservation: z.object({ tokens: z.number().finite().nonnegative(), requests: z.number().finite().nonnegative(), usd: z.number().finite().nonnegative() }).strict().optional(),
  pricing: z.object({ snapshotHash: sha256Schema, refreshedAt: date, currency: z.literal("USD"),
    scenarioId: id, accountingAssumption: z.string().nullable() }).strict().optional(),
  outcome: id, wireApi: id, authMode: id, runtimeHash: sha256Schema,
  replay: z.array(z.object({ type: id, text: z.string().max(4000) }).strict()).max(10000),
  replayState: z.enum(["available", "missing", "truncated"]).optional(),
}).strict();
export const reportEvidenceSchema = z.object({
  schemaVersion: z.literal(1), campaignId: id, createdAt: date,
  selectionPolicy: z.literal("latest-clean-completion"),
  tasks: z.array(taskSchema), candidates: z.array(candidateSchema),
  repeats: z.number().int().min(1).max(1000),
  attempts: z.array(attemptSchema).max(100000),
  selected: z.record(z.string(), id).optional(),
  caveats: z.array(z.string()),
}).strict();
export type ReportEvidence = z.infer<typeof reportEvidenceSchema>;
export type EvidenceAttempt = ReportEvidence["attempts"][number];
export type ReportCell = {
  id: string; task: string; candidate: string; repeat: number;
  status: "pass" | "fail" | "error" | "ungraded" | "interrupted" | "missing";
  selected: EvidenceAttempt | null; attempts: EvidenceAttempt[]; reason: string;
};

export function evidenceHash(value: unknown): string {
  const canonical = (item: unknown): string => {
    if (Array.isArray(item)) return `[${item.map(canonical).join(",")}]`;
    if (item !== null && typeof item === "object") {
      return `{${Object.entries(item).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`).join(",")}}`;
    }
    return JSON.stringify(item);
  };
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export function cellId(task: string, candidate: string, repeat: number): string {
  return JSON.stringify([task, candidate, repeat]);
}

export const MAX_REPORT_CELLS = 100000;

export function parseReportEvidence(value: unknown): ReportEvidence {
  const evidence = reportEvidenceSchema.parse(value);
  if (evidence.tasks.length * evidence.candidates.length * evidence.repeats > MAX_REPORT_CELLS) throw new RangeError("Report exceeds the 100,000-cell in-memory publication bound; publish independently identified subsets.");
  const unique = (values: string[], label: string) => {
    if (new Set(values).size !== values.length) throw new TypeError(`Duplicate ${label}.`);
  };
  unique(evidence.tasks.map((task) => task.id), "task IDs");
  unique(evidence.candidates.map((candidate) => candidate.id), "candidate IDs");
  unique(evidence.attempts.map((attempt) => attempt.id), "attempt IDs");
  const tasks = new Map(evidence.tasks.map((task) => [task.id, task]));
  const candidates = new Set(evidence.candidates.map((candidate) => candidate.id));
  const attempts = new Map(evidence.attempts.map((attempt) => [attempt.id, attempt]));
  for (const attempt of evidence.attempts) {
    const task = tasks.get(attempt.task);
    if (!task || !candidates.has(attempt.candidate)
        || attempt.repeat >= evidence.repeats) throw new TypeError("Attempt is outside the declared task/candidate/repeat cohort.");
    if (attempt.cohortHash !== task.cohortHash) throw new TypeError("Attempt comparison cohort does not match declared task.");
    if (attempt.policyHash && task.evaluatorPolicyHash && attempt.policyHash !== task.evaluatorPolicyHash) {
      throw new TypeError("Evaluator policy mismatch; use a separate cohort or uniformly regrade saved outputs.");
    }
    if (attempt.acceptance === "pass" && (attempt.requiredFailed || (attempt.requiredErrors ?? attempt.checkErrors) || !attempt.requiredPassed)) {
      throw new TypeError("Acceptance PASS requires nonempty, error-free required evidence.");
    }
    if (attempt.acceptance === "fail" && !attempt.requiredFailed || attempt.acceptance === "error" && !attempt.checkErrors) {
      throw new TypeError("Acceptance verdict contradicts required/error check counts.");
    }
    if (Date.parse(attempt.completedAt) < Date.parse(attempt.startedAt)) throw new TypeError("Attempt completed before it started.");
  }
  for (const [pair, attemptId] of Object.entries(evidence.selected ?? {})) {
    const attempt = attempts.get(attemptId);
    if (!attempt || pair !== cellId(attempt.task, attempt.candidate, attempt.repeat)
        || attempt.execution !== "completed") throw new TypeError("Explicit selection must bind a clean completed attempt to its exact declared cell.");
  }
  return evidence;
}

export function selectReportCells(input: ReportEvidence): ReportCell[] {
  const evidence = parseReportEvidence(input);
  const grouped = new Map<string, EvidenceAttempt[]>();
  for (const attempt of evidence.attempts) {
    const key = cellId(attempt.task, attempt.candidate, attempt.repeat);
    const attempts = grouped.get(key) ?? []; attempts.push(attempt); grouped.set(key, attempts);
  }
  return evidence.tasks.flatMap((task) => evidence.candidates.flatMap((candidate) =>
    Array.from({ length: evidence.repeats }, (_, repeat): ReportCell => {
      const id = cellId(task.id, candidate.id, repeat);
      const attempts = (grouped.get(id) ?? [])
        .sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt) || Date.parse(a.startedAt) - Date.parse(b.startedAt) || a.id.localeCompare(b.id));
      const pinned = evidence.selected?.[id];
      const selected = pinned ? attempts.find((a) => a.id === pinned)! : attempts.filter((a) => a.execution === "completed").at(-1) ?? null;
      return {
        id, task: task.id, candidate: candidate.id, repeat, selected, attempts,
        status: selected?.acceptance ?? (attempts.length ? attempts.at(-1)!.execution === "error" ? "error" : "interrupted" : "missing"),
        reason: pinned ? "Explicit immutable selection" : selected ? "Latest clean execution, irrespective of content verdict" : attempts.length ? "No clean completion" : "No recorded attempt",
      };
    })));
}

export function cohortHash(contract: RunContract): string {
  return evidenceHash({
    task: contract.task, execution: contract.execution, rounds: contract.rounds ?? null,
    runtime: contract.runtime,
    executionProfile: contract.executionProfile ?? null,
  });
}

const metricSchema = z.object({
  status: z.enum(["available", "unavailable"]), value: z.number().finite().nonnegative().nullable(),
}).passthrough().superRefine((v, ctx) => {
  if ((v.status === "available") !== (v.value !== null)) ctx.addIssue({ code: "custom", message: "Metric availability/value mismatch." });
});
export function assertBenchmarkRun(value: unknown): asserts value is BenchmarkRun {
  z.object({
    runId: id, contractHash: sha256Schema, startedAt: date, completedAt: date,
    contract: z.object({
      contractVersion: z.union([z.literal(1), z.literal(2)]),
      task: z.object({ id, prompt: z.string(), validationCommand: z.string(), repository: z.object({ commitSha: id, containerFingerprint: id }).passthrough() }).passthrough(),
      candidate: z.object({ provider: id, model: id, deployment: id.optional() }),
      execution: z.object({ instructions: z.string(), tools: z.array(z.enum(["read", "edit", "shell"])), retries: count,
        sessionTimeoutMs: z.number().positive(), reasoningEffort: id }).passthrough(),
      runtime: z.object({ sdkVersion: id, cliVersion: id, nodeVersion: id, cliSha256: sha256Schema.optional() }),
      rounds: z.array(z.object({ prompt: z.string(), mode: z.enum(["enqueue", "immediate"]).optional() })).optional(),
    }).passthrough(),
    artifacts: z.object({ directory: z.string(), rawEvents: z.string(), normalizedEvents: z.string(), diagnostics: z.string(), report: z.string() }).passthrough(),
    modelCalls: z.array(z.unknown()), toolCalls: z.array(z.unknown()),
    metrics: z.object({
      e2eMs: metricSchema, inputTokens: metricSchema, outputTokens: metricSchema,
      cacheReadTokens: metricSchema, cacheWriteTokens: metricSchema, cost: metricSchema,
    }).passthrough(),
    outcome: z.object({ class: z.enum(["resolved", "unresolved", "empty_patch", "rate_limit", "timeout", "tool_container_failure", "harness_failure"]), category: id, detail: z.string() }),
    runnerError: z.string().nullable(),
    executionStatus: z.enum(["completed", "interrupted"]).optional(),
    requestAccounting: z.object({ physicalRequests: count, reservedTokens: count, ambiguousRequests: count, rejectedRequests: count }).strict().optional(),
    workspaceHash: sha256Schema.optional(),
    conformance: conformanceEvidenceSchema.optional(),
    validation: z.object({ exitCode: z.number().int().nullable(), timedOut: z.boolean(), errorMessage: z.string().nullable() }).passthrough().nullable(),
  }).passthrough().parse(value);
  const run = value as BenchmarkRun;
  if (run.conformance && new Set(run.conformance.checks.map((c) => c.id)).size !== run.conformance.checks.length) throw new TypeError("Duplicate conformance check IDs.");
  if (run.executionStatus === "completed" && run.runnerError !== null) throw new TypeError("Completed execution contradicts its runner error.");
  if (run.executionStatus === "completed" && run.requestAccounting?.ambiguousRequests) throw new TypeError("Completed execution contradicts ambiguous dispatch accounting.");
  if (immutableContractHash(run.contract) !== run.contractHash) throw new TypeError(`Contract hash mismatch for run ${run.runId}.`);
}

export function attemptFromRun(
  run: BenchmarkRun, task: string, candidate: string, repeat = 0, grade?: EvaluatorGrade,
): EvidenceAttempt {
  assertBenchmarkRun(run);
  if (grade) {
    grade = gradeSchema.parse(grade);
    if (grade.runId !== run.runId || grade.contractHash !== run.contractHash || grade.workspaceHash !== run.workspaceHash) {
      throw new TypeError("Grade does not bind this run, contract and exact graded workspace.");
    }
  }
  const sidecar = run.artifacts.conformance ?? join(run.artifacts.directory, "conformance-probe.json");
  const probe = run.conformance ?? (existsSync(sidecar) ? conformanceEvidenceSchema.parse(JSON.parse(readFileSync(sidecar, "utf8"))) : null);
  if (probe && new Set(probe.checks.map((c) => c.id)).size !== probe.checks.length) throw new TypeError("Duplicate conformance check IDs.");
  const checks = grade?.checks ?? (probe?.available ? probe.checks : []);
  const errors = checks.filter((c) => c.status === "error").length;
  const required = checks.filter((c) => c.severity === "required");
  const requiredErrors = required.filter((c) => c.status === "error").length;
  const failed = required.filter((c) => c.status === "fail").length;
  const completed = run.executionStatus ? run.executionStatus === "completed"
    : run.runnerError === null && ["resolved", "unresolved", "empty_patch"].includes(run.outcome.class);
  const validation = !run.validation ? "unavailable" : run.validation.timedOut || run.validation.errorMessage || run.validation.exitCode === null
    ? "error" : run.validation.exitCode === 0 ? "pass" : "fail";
  const acceptance = requiredErrors ? "error" : failed ? "fail" : required.length && required.every((c) => c.status === "pass")
    ? "pass" : errors ? "error" : "ungraded";
  const number = (name: keyof BenchmarkRun["metrics"]) => run.metrics[name].status === "available" ? run.metrics[name].value : null;
  return {
    id: run.runId, task, candidate, repeat, contractHash: run.contractHash,
    promptHash: evidenceHash({ prompt: run.contract.task.prompt, instructions: run.contract.execution.instructions }),
    roundsHash: evidenceHash(run.contract.rounds ?? null), cohortHash: cohortHash(run.contract),
    workspaceHash: run.workspaceHash ?? null, startedAt: run.startedAt, completedAt: run.completedAt,
    comparisonHash: comparableBaselineSignature(run.contract) ? evidenceHash(comparableBaselineSignature(run.contract)) : null,
    execution: completed ? "completed" : "interrupted", phase: completed ? "graded" : "execution",
    validation, acceptance, requiredPassed: required.filter((c) => c.status === "pass").length,
    requiredFailed: failed, advisoryFailed: checks.filter((c) => c.severity === "advisory" && ["fail", "weak"].includes(c.status)).length,
    checkErrors: errors, requiredErrors, policyHash: grade?.policyHash ?? (run.contract.task.conformanceProbe ? evidenceHash(run.contract.task.conformanceProbe) : null),
    evaluatorVersion: grade?.evaluatorVersion ?? (probe ? "legacy-conformance-v1" : null), calibrated: grade?.calibrated ?? null,
    metrics: {
      wallMs: number("e2eMs"), inputTokens: number("inputTokens"), outputTokens: number("outputTokens"),
      recordedCost: number("cost"), recordedUsd: run.recordedPricing?.estimatedUsd ?? null, modelUsageRecords: run.modelCalls.length,
      physicalRequests: run.requestAccounting?.physicalRequests ?? null,
    },
    accounting: {
      reservedTokens: run.requestAccounting?.reservedTokens ?? null, ambiguousRequests: run.requestAccounting?.ambiguousRequests ?? null,
      rejectedRequests: run.requestAccounting?.rejectedRequests ?? null,
    },
    ...(run.recordedPricing ? { pricing: {
      snapshotHash: run.recordedPricing.snapshotHash, refreshedAt: run.recordedPricing.refreshedAt, currency: run.recordedPricing.currency,
      scenarioId: run.recordedPricing.scenarioId, accountingAssumption: run.recordedPricing.accountingAssumption,
    } } : {}),
    outcome: run.outcome.class, wireApi: run.contract.foundryProvider?.wireApi ?? (run.contract.candidate.provider === "openai" ? "completions (legacy)" : "messages"),
    authMode: run.contract.foundryProvider?.auth?.mode ?? "key (legacy)", runtimeHash: evidenceHash(run.contract.runtime),
    ...loadMetadataReplay(run),
  };
}

export function loadMetadataReplay(run: BenchmarkRun): Pick<EvidenceAttempt, "replay" | "replayState"> {
  if (!existsSync(run.artifacts.normalizedEvents)) return { replay: [], replayState: "missing" };
  if (statSync(run.artifacts.normalizedEvents).size > 16 * 1024 * 1024) return { replay: [], replayState: "truncated" };
  const replay: EvidenceAttempt["replay"] = [];
  const name = (value: unknown): string | null => typeof value === "string" && /^[a-zA-Z0-9_./:-]{1,150}$/.test(value) ? value : null;
  const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
  const boolean = (value: unknown): boolean | null => typeof value === "boolean" ? value : null;
  const lines = readFileSync(run.artifacts.normalizedEvents, "utf8").split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const event = z.object({ eventType: z.string(), data: z.record(z.string(), z.unknown()) }).passthrough().parse(JSON.parse(line));
    const d = event.data;
    const metadata = event.eventType === "assistant.usage" ? {
      model: name(d.model), inputTokens: number(d.inputTokens), outputTokens: number(d.outputTokens),
      cacheReadTokens: number(d.cacheReadTokens), cacheWriteTokens: number(d.cacheWriteTokens),
    } : event.eventType === "tool.execution_start" ? { toolName: name(d.toolName ?? d.name), toolCallId: name(d.toolCallId) }
      : event.eventType === "tool.execution_complete" ? { toolCallId: name(d.toolCallId), success: boolean(d.success) }
      : event.eventType === "runner.validation_finished" ? { exitCode: number(d.exitCode), timedOut: boolean(d.timedOut), durationMs: number(d.durationMs) }
      : ["runner.run_started", "runner.run_finished", "assistant.turn_start", "session.idle"].includes(event.eventType) ? { event: event.eventType } : null;
    if (metadata) replay.push({ type: event.eventType, text: JSON.stringify(metadata) });
    if (replay.length === 1000) return { replay, replayState: "truncated" };
  }
  return { replay, replayState: "available" };
}

export function evidenceFromRuns(runs: readonly BenchmarkRun[], campaignId = "imported-runs"): ReportEvidence {
  const tasks = new Map<string, ReportEvidence["tasks"][number]>();
  const candidates = new Map<string, ReportEvidence["candidates"][number]>();
  const attempts: EvidenceAttempt[] = [];
  for (const run of runs) {
    const cohort = cohortHash(run.contract);
    const task = `${run.contract.task.id}:${cohort.slice(0, 16)}`;
    const candidate = candidateKey(run);
    tasks.set(task, {
      id: task, taskId: run.contract.task.id, version: run.contract.task.version ?? "legacy",
      title: run.contract.task.title ?? run.contract.task.id, taskType: run.contract.task.taskType, tags: run.contract.task.tags ?? [],
      taskHash: evidenceHash(run.contract.task), cohortHash: cohort,
    });
    candidates.set(candidate, { id: candidate, ...run.contract.candidate });
    attempts.push(attemptFromRun(run, task, candidate));
  }
  const caveats: string[] = ["Latest cleanly completed execution is selected, including content FAILs. Interrupted recovery does not replace completed work.",
    "Candidate-owned validation is separate from independent acceptance. Ungraded is not PASS.",
    "SDK cost multipliers are not currency or invoices; unavailable spend is not zero. Single samples do not establish reliability."];
  if (runs.some((r) => r.contract.executionProfile?.mode !== "container")) caveats.push("Trusted-local executions can access host files, resources and identity caches. They are not credential-isolated.");
  for (const task of tasks.keys()) {
    const contracts = runs.filter((run) => `${run.contract.task.id}:${cohortHash(run.contract).slice(0, 16)}` === task).map((run) => run.contract);
    if (contracts.some((c) => comparableBaselineSignature(c) === null)
        || !compareRunContractSet(contracts).strictlyComparable) caveats.push(`Task cohort ${task} is descriptive: protocol/runtime/round comparability is not established.`);
  }
  return parseReportEvidence({
    schemaVersion: 1, campaignId, createdAt: new Date().toISOString(), selectionPolicy: "latest-clean-completion",
    tasks: [...tasks.values()], candidates: [...candidates.values()], repeats: 1, attempts, caveats,
  });
}

export function taskTypeAnalysis(evidence: ReportEvidence) {
  const cells = selectReportCells(evidence);
  return [...new Set(evidence.tasks.map((t) => t.taskType ?? "unclassified"))].flatMap((taskType) => {
    const tasks = evidence.tasks.filter((t) => (t.taskType ?? "unclassified") === taskType);
    const matched = tasks.filter((t) => evidence.candidates.every((c) =>
      Array.from({ length: evidence.repeats }, (_, r) => cells.find((cell) => cell.id === cellId(t.id, c.id, r))!)
        .every((cell) => cell.selected && ["pass", "fail"].includes(cell.status)))
      && new Set(cells.filter((c) => c.task === t.id).map((c) => c.selected?.wireApi)).size === 1
      && cells.filter((c) => c.task === t.id).every((c) => c.selected?.comparisonHash)
      && new Set(cells.filter((c) => c.task === t.id).map((c) => c.selected?.comparisonHash)).size === 1);
    return evidence.candidates.map((candidate) => {
      const samples = cells.filter((cell) => matched.some((t) => t.id === cell.task) && cell.candidate === candidate.id);
      const completeMean = (select: (a: EvidenceAttempt) => number | null) => {
        const values = samples.map((c) => select(c.selected!));
        return values.length && values.every((v) => v !== null) ? values.reduce((sum, v) => sum + v!, 0) / values.length : null;
      };
      return {
        taskType, candidate: candidate.id, declaredTasks: tasks.length, matchedTasks: matched.length,
        samples: samples.length, passed: samples.filter((c) => c.status === "pass").length,
        meanWallMs: completeMean((a) => a.metrics.wallMs), meanRecordedUsd: completeMean((a) => a.metrics.recordedUsd),
        guidance: samples.length < 3 ? "Sparse descriptive evidence; no reliability or routing claim." : "Post-hoc matched coverage only; routing is not validated.",
      };
    });
  });
}
