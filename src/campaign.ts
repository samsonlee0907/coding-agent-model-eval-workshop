import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { freemem } from "node:os";
import { z } from "zod";
import { providerSchema } from "./auth.js";
import { benchmarkConfigSchema } from "./config-schema.js";
import { collectSnapshot, ControlledWorker, snapshotHash, validateSnapshot, writeSnapshot, type SnapshotFile } from "./controlled-worker.js";
import { atomicJson, acquireOwnership, appendJournal, readJournal } from "./durable.js";
import { MAX_REPORT_CELLS, attemptFromRun, cohortHash, evidenceHash, gradeSchema, parseReportEvidence, selectReportCells, type ReportEvidence } from "./evidence.js";
import { runBenchmark, resumeBenchmarkFinalization, executionProfile, type BenchmarkRunOptions } from "./runner.js";
import { DeploymentAdmission, realClock, requestBoundsSchema, type PolicyClock } from "./request-policy.js";
import { readRuntimeIdentity } from "./runtime-identity.js";
import { gradeSavedRun, parseEvaluatorPolicy, verifyCalibration, type EvaluatorPolicy, type EvaluatorCalibration } from "./task-evaluator.js";
import { writeReportBundle, safeRelativePath } from "./publication.js";
import type { BenchmarkConfig, BenchmarkRun, RunContract, RuntimeIdentity } from "./types.js";
import { assertBenchmarkRun } from "./evidence.js";
import { parsePricingSnapshot, estimateRunPriceUsd, type PricingSnapshot } from "./pricing.js";

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/);
export const campaignSpecSchema = z.object({
  schemaVersion: z.literal(1), id: identifier,
  tasks: z.array(z.object({ id: identifier, config: z.string(), evaluator: z.string().optional(), calibration: z.string().optional(),
    graderInputs: z.string().optional() }).strict()).min(1),
  candidates: z.array(z.object({
    id: identifier,
    candidate: z.object({ provider: z.enum(["openai", "anthropic"]), model: z.string().min(1), deployment: z.string().optional() }).strict(),
    foundryProvider: providerSchema,
  }).strict()).min(1),
  repeats: z.number().int().min(1).max(1000),
  inputBounds: z.object({ maxFiles: z.number().int().positive(), maxBytes: z.number().int().positive().max(64 * 1024 * 1024) }).strict(),
  requestBounds: requestBoundsSchema,
  bounds: z.object({
    concurrency: z.number().int().min(1).max(64), minFreeMemoryMb: z.number().int().nonnegative(),
    maxAttemptsPerCell: z.number().int().min(1).max(10), deadlineMs: z.number().int().positive(),
    maxRequests: z.number().int().positive(), maxReservedTokens: z.number().int().positive(),
    maxReservationUsd: z.number().positive(), reservationUsdPerMillionTokens: z.number().positive(),
  }).strict(),
  requireCalibratedEvaluators: z.boolean().default(false),
  pricing: z.object({
    snapshot: z.string(), scenarios: z.record(z.string(), z.string()),
    anthropicAccounting: z.enum(["sdk-inclusive", "native-uncached"]).optional(),
  }).strict().optional(),
}).strict().refine((spec) => spec.tasks.length * spec.candidates.length * spec.repeats <= MAX_REPORT_CELLS,
  "Campaign exceeds the in-memory publication bound; prepare independently identified subsets.");
export type CampaignSpec = z.infer<typeof campaignSpecSchema>;
type PreparedTask = { id: string; config: BenchmarkConfig; files: SnapshotFile[]; graderFiles?: SnapshotFile[];
  evaluator?: EvaluatorPolicy; calibration?: EvaluatorCalibration };
export type PreparedCampaign = {
  schemaVersion: 1; hash: string; createdAt: string; spec: CampaignSpec; runtime: RuntimeIdentity; tasks: PreparedTask[];
  pricing?: PricingSnapshot;
};
const eventSchema = z.object({
  schemaVersion: z.literal(1), sequence: z.number().int().positive(), at: z.string().datetime(),
  pair: z.string(), attemptId: z.string().uuid(), state: z.enum(["reserved", "running", "finalizing", "completed", "interrupted", "error"]),
  phase: z.string(), runPath: z.string().optional(), message: z.string().optional(),
  reservation: z.object({ tokens: z.number().nonnegative(), requests: z.number().nonnegative(), usd: z.number().nonnegative() }).optional(),
}).strict();
type CampaignEvent = z.infer<typeof eventSchema>;

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new TypeError(`Duplicate campaign ${label}.`);
}

export function prepareCampaign(specPath: string, output: string, runtime = readRuntimeIdentity()): PreparedCampaign {
  const root = dirname(resolve(specPath));
  const spec = campaignSpecSchema.parse(JSON.parse(readFileSync(specPath, "utf8")));
  unique(spec.tasks.map((t) => t.id), "task IDs"); unique(spec.candidates.map((c) => c.id), "candidate IDs");
  for (const candidate of spec.candidates) if (candidate.candidate.provider !== candidate.foundryProvider.type) throw new TypeError("Campaign candidate/provider wire shape mismatch.");
  const tasks: PreparedTask[] = spec.tasks.map((task) => {
    const path = resolve(root, task.config);
    const config: BenchmarkConfig = benchmarkConfigSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    if (config.contract.task.id !== task.id) throw new TypeError("Campaign task ID must equal its configuration task ID.");
    config.workspacePath = resolve(dirname(path), config.workspacePath);
    const files = collectSnapshot(config.workspacePath, spec.inputBounds.maxFiles, spec.inputBounds.maxBytes);
    config.contract.task.inputsHash = snapshotHash(files);
    config.contract.runtime = { ...runtime };
    config.requestBounds = spec.requestBounds;
    if (config.isolation) config.contract.task.repository.containerFingerprint = config.isolation.image;
    const evaluator = task.evaluator ? parseEvaluatorPolicy(JSON.parse(readFileSync(resolve(root, task.evaluator), "utf8"))) : undefined;
    if (task.graderInputs && (!evaluator || !config.isolation)) throw new TypeError("Private grader assets require an evaluator and isolated container mode.");
    if (task.graderInputs) {
      const inputRoot = realpathSync(config.workspacePath), graderRoot = realpathSync(resolve(root, task.graderInputs));
      const within = (parent: string, child: string) => {
        const path = relative(parent, child);
        return !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`);
      };
      if (within(inputRoot, graderRoot) || within(graderRoot, inputRoot)) throw new TypeError("Private grader and candidate input roots must be disjoint.");
    }
    const graderFiles = task.graderInputs ? collectSnapshot(resolve(root, task.graderInputs), spec.inputBounds.maxFiles, spec.inputBounds.maxBytes) : undefined;
    const graderInputsHash = graderFiles ? snapshotHash(graderFiles) : undefined;
    if (evaluator?.graderInputsHash !== graderInputsHash) throw new TypeError("Evaluator policy must pin the exact private grader input hash.");
    if (graderInputsHash) config.contract.task.graderInputsHash = graderInputsHash;
    const calibration = task.calibration ? verifyCalibration(evaluator ?? (() => { throw new TypeError("Calibration requires an evaluator."); })(),
      JSON.parse(readFileSync(resolve(root, task.calibration), "utf8"))) : undefined;
    if (spec.requireCalibratedEvaluators && (!evaluator || !calibration?.calibrated)) throw new TypeError("Campaign requires reference-calibrated task evaluators.");
    return { id: task.id, config, files, ...(graderFiles ? { graderFiles } : {}), ...(evaluator ? { evaluator } : {}), ...(calibration ? { calibration } : {}) };
  });
  const directory = resolve(output);
  if (existsSync(directory)) throw new Error("Campaign destination exists; immutable preparation requires a new directory.");
  const pricing = spec.pricing ? parsePricingSnapshot(readFileSync(resolve(root, spec.pricing.snapshot), "utf8")) : undefined;
  if (spec.pricing && spec.candidates.some((c) => !spec.pricing!.scenarios[c.id])) throw new TypeError("Pinned campaign pricing requires an explicit scenario ID for every candidate.");
  const body = { schemaVersion: 1 as const, createdAt: new Date().toISOString(), spec, runtime, tasks, ...(pricing ? { pricing } : {}) };
  const prepared = { ...body, hash: evidenceHash(body) };
  mkdirSync(directory, { recursive: true });
  atomicJson(join(directory, "prepared.json"), prepared);
  return prepared;
}

export function loadPreparedCampaign(directory: string): PreparedCampaign {
  const value = JSON.parse(readFileSync(join(directory, "prepared.json"), "utf8")) as PreparedCampaign;
  const { hash, ...body } = value;
  if (value.schemaVersion !== 1 || evidenceHash(body) !== hash) throw new TypeError("Prepared campaign version/hash mismatch.");
  campaignSpecSchema.parse(value.spec);
  unique(value.tasks.map((t) => t.id), "prepared task IDs");
  if (value.tasks.length !== value.spec.tasks.length || value.tasks.some((t) => !value.spec.tasks.some((s) => s.id === t.id))) throw new TypeError("Prepared task declarations differ from the campaign.");
  if (value.pricing) parsePricingSnapshot(JSON.stringify(value.pricing));
  for (const task of value.tasks) {
    benchmarkConfigSchema.parse(task.config);
    validateSnapshot(task.files, value.spec.inputBounds.maxFiles, value.spec.inputBounds.maxBytes);
    if (snapshotHash(task.files) !== task.config.contract.task.inputsHash) throw new TypeError("Prepared task input binding changed.");
    if (task.graderFiles) validateSnapshot(task.graderFiles, value.spec.inputBounds.maxFiles, value.spec.inputBounds.maxBytes);
    const graderHash = task.graderFiles ? snapshotHash(task.graderFiles) : undefined;
    if (graderHash !== task.evaluator?.graderInputsHash || graderHash !== task.config.contract.task.graderInputsHash) throw new TypeError("Prepared private grader input binding changed.");
    if (evidenceHash(task.config.contract.runtime) !== evidenceHash(value.runtime)
        || evidenceHash(task.config.requestBounds) !== evidenceHash(value.spec.requestBounds)) throw new TypeError("Prepared runtime/request-bound binding changed.");
    if (task.evaluator) parseEvaluatorPolicy(task.evaluator);
    if (task.calibration) verifyCalibration(task.evaluator!, task.calibration);
  }
  return value;
}

function journal(directory: string, repairTornTail = false): CampaignEvent[] {
  const events = readJournal(join(directory, "journal.ndjson"), (value) => eventSchema.parse(value), repairTornTail);
  for (let i = 0; i < events.length; i++) if (events[i].sequence !== i + 1) throw new Error("Campaign journal sequence corruption.");
  return events;
}
function pairId(task: string, candidate: string, repeat: number): string { return JSON.stringify([task, candidate, repeat]); }
function cells(prepared: PreparedCampaign) {
  return prepared.tasks.flatMap((task) => prepared.spec.candidates.flatMap((candidate) =>
    Array.from({ length: prepared.spec.repeats }, (_, repeat) => ({ task, candidate, repeat, pair: pairId(task.id, candidate.id, repeat) }))));
}

export interface CampaignRunOptions {
  allowPaid: boolean; recoverLock?: boolean; recoverRejected?: boolean;
  run?: (config: BenchmarkConfig, options: BenchmarkRunOptions) => Promise<BenchmarkRun>;
  finalize?: typeof resumeBenchmarkFinalization;
  clock?: PolicyClock; freeMemory?: () => number;
  runtime?: RuntimeIdentity;
}

export async function runCampaign(directory: string, options: CampaignRunOptions): Promise<ReportEvidence> {
  if (!options.allowPaid) throw new Error("Campaign run/resume requires explicit --allow-paid and reviewed finite request/token/reservation bounds.");
  const prepared = loadPreparedCampaign(directory);
  const currentRuntime = options.runtime ?? readRuntimeIdentity();
  if (evidenceHash(currentRuntime) !== evidenceHash(prepared.runtime)) throw new Error("Runtime identity changed since preparation. Prepare a new comparison cohort.");
  const release = acquireOwnership(join(directory, "owner.lock"), options.recoverLock);
  try {
    const events = journal(directory, true), clock = options.clock ?? realClock;
    const firstReservation = events.find((event) => event.state === "reserved");
    const deadline = (firstReservation ? Date.parse(firstReservation.at) : clock.now()) + prepared.spec.bounds.deadlineMs;
    const admission = new DeploymentAdmission(clock);
    const latest = (pair: string) => events.filter((e) => e.pair === pair).at(-1);
    const append = (value: Omit<CampaignEvent, "schemaVersion" | "sequence" | "at">) => {
      const event = eventSchema.parse({ ...value, schemaVersion: 1, sequence: events.length + 1, at: new Date(clock.now()).toISOString() });
      appendJournal(join(directory, "journal.ndjson"), event); events.push(event);
      atomicJson(join(directory, "state.json"), { schemaVersion: 1, preparedHash: prepared.hash, sequence: event.sequence, cells: cells(prepared).map((c) => ({ pair: c.pair, latest: latest(c.pair) ?? null })) });
    };
    const queue = cells(prepared), errors: string[] = [];
    let cursor = 0, halt = false;
    const configFor = (cell: typeof queue[number], attemptId: string): BenchmarkConfig => {
      const config: BenchmarkConfig = structuredClone(cell.task.config);
      config.contract.candidate = cell.candidate.candidate;
      config.contract.foundryProvider = cell.candidate.foundryProvider;
      config.workspacePath = join(directory, "attempts", attemptId, "input");
      config.artifactsDirectory = join(directory, "runs");
      return config;
    };
    const perform = async (cell: typeof queue[number]) => {
      const previous = latest(cell.pair);
      if (previous?.state === "completed") return;
      let attemptId = previous?.attemptId ?? randomUUID();
      const attempts = events.filter((e) => e.pair === cell.pair && e.state === "reserved").length;
      let config = configFor(cell, attemptId);
      const checkpoint = join(directory, "runs", attemptId, "execution.json");
      const retainedRun = join(directory, "runs", attemptId, "run.json");
      let finalize = !!previous && (existsSync(checkpoint) || existsSync(retainedRun));
      if (previous && !finalize) {
        append({ pair: cell.pair, attemptId, state: "interrupted", phase: previous.phase, message: "No completed checkpoint; dispatch certainty is unknown. Automatic inference replay denied." });
        errors.push(`${cell.pair}: interrupted; no dispatch-safe checkpoint`); return;
      }
      if (previous?.state === "interrupted" && finalize) {
        const run: unknown = existsSync(retainedRun) ? JSON.parse(readFileSync(retainedRun, "utf8")) : null;
        if (run) {
          assertBenchmarkRun(run);
          const accounting = run.requestAccounting;
          const safe = accounting && accounting.physicalRequests > 0 && !accounting.ambiguousRequests
            && accounting.physicalRequests === accounting.rejectedRequests && run.diagnostics.providerFailure.httpStatus === 429
            && run.diagnostics.providerFailure.signature !== "permanent_quota";
          if (!options.recoverRejected || !safe || attempts >= prepared.spec.bounds.maxAttemptsPerCell) return;
          attemptId = randomUUID(); config = configFor(cell, attemptId); finalize = false;
        }
      }
      if (!finalize) {
        if (clock.now() >= deadline) throw new Error("Campaign admission deadline exceeded.");
        if (attempts >= prepared.spec.bounds.maxAttemptsPerCell) throw new Error("Per-cell attempt bound reached.");
        const reservations = events.flatMap((e) => e.reservation ? [e.reservation] : []);
        const next = {
          tokens: prepared.spec.requestBounds.maxTokens, requests: prepared.spec.requestBounds.maxRequests,
          usd: prepared.spec.requestBounds.maxTokens / 1000000 * prepared.spec.bounds.reservationUsdPerMillionTokens,
        };
        if (reservations.reduce((sum, r) => sum + r.tokens, 0) + next.tokens > prepared.spec.bounds.maxReservedTokens
            || reservations.reduce((sum, r) => sum + r.requests, 0) + next.requests > prepared.spec.bounds.maxRequests
            || reservations.reduce((sum, r) => sum + r.usd, 0) + next.usd > prepared.spec.bounds.maxReservationUsd) {
          throw new Error("Campaign protective request/token/USD reservation budget exhausted (not an invoice).");
        }
        if (!existsSync(config.workspacePath)) writeSnapshot(config.workspacePath, cell.task.files, prepared.spec.inputBounds.maxFiles, prepared.spec.inputBounds.maxBytes);
        append({ pair: cell.pair, attemptId, state: "reserved", phase: "prepared", reservation: next });
      }
      const onPhase: BenchmarkRunOptions["onPhase"] = (phase) => append({
        pair: cell.pair, attemptId, state: phase === "running" ? "running" : "finalizing", phase,
      });
      let run: BenchmarkRun;
      const operationDeadline = finalize ? clock.now() + prepared.spec.requestBounds.deadlineMs : deadline;
      try {
        if (existsSync(join(directory, "runs", attemptId, "run.json"))) {
          const loaded: unknown = JSON.parse(readFileSync(join(directory, "runs", attemptId, "run.json"), "utf8"));
          assertBenchmarkRun(loaded); run = loaded;
        } else {
          run = finalize
            ? await (options.finalize ?? resumeBenchmarkFinalization)(config, attemptId, { onPhase, admission, deadlineAt: operationDeadline })
            : await (options.run ?? runBenchmark)(config, { runId: attemptId, onPhase, admission, deadlineAt: operationDeadline });
        }
        assertBenchmarkRun(run);
        if (run.runId !== attemptId || evidenceHash(run.contract.task) !== evidenceHash(config.contract.task)
            || evidenceHash(run.contract.candidate) !== evidenceHash(config.contract.candidate)
            || evidenceHash(run.contract.execution) !== evidenceHash(config.contract.execution)
            || evidenceHash(run.contract.rounds) !== evidenceHash(config.rounds)
            || evidenceHash(run.contract.runtime) !== evidenceHash(prepared.runtime)) throw new Error("Execution differs from immutable prepared task/candidate/prompt/runtime bindings.");
        if (!run.workspaceHash && run.artifacts.workspace) {
          run.workspaceHash = snapshotHash(collectSnapshot(run.artifacts.workspace, prepared.spec.inputBounds.maxFiles, prepared.spec.inputBounds.maxBytes));
          atomicJson(join(directory, "runs", attemptId, "run.json"), run);
        }
        if (prepared.pricing && prepared.spec.pricing && !run.recordedPricing) {
          const scenarioId = prepared.spec.pricing.scenarios[cell.candidate.id];
          const price = estimateRunPriceUsd(run, prepared.pricing, scenarioId, prepared.spec.pricing.anthropicAccounting);
          run.recordedPricing = {
            snapshotHash: evidenceHash(prepared.pricing), refreshedAt: prepared.pricing.refreshedAt,
            currency: "USD", scenarioId, estimatedUsd: price.totalUsd,
            accountingAssumption: price.accountingAssumption, unavailableReason: price.unavailableReason,
          };
          atomicJson(join(directory, "runs", attemptId, "run.json"), run);
        }
        if (cell.task.evaluator && run.executionStatus === "completed") {
          onPhase("grading", { runId: attemptId, artifactsDirectory: dirname(retainedRun) });
          const gradePath = join(directory, "runs", attemptId, "grade.json");
          if (!existsSync(gradePath)) {
            if (!run.workspaceHash || !run.artifacts.workspace) throw new Error("Evaluator requires a retained, hash-bound workspace.");
            let grader: ControlledWorker | null = null;
            try {
              const files = collectSnapshot(run.artifacts.workspace, config.isolation?.maxFiles ?? prepared.spec.inputBounds.maxFiles,
                config.isolation?.maxBytes ?? prepared.spec.inputBounds.maxBytes);
              if (snapshotHash(files) !== run.workspaceHash) throw new Error("Retained workspace bytes changed before task grading.");
              if (config.isolation) grader = await ControlledWorker.create(config.isolation,
                files,
                join(directory, "runs", attemptId, `private-grader-${randomUUID()}.json`), undefined, cell.task.graderFiles, operationDeadline);
              let gradingRun = run;
              if (!config.isolation) {
                const workspace = join(directory, "runs", attemptId, `grading-input-${randomUUID()}`);
                writeSnapshot(workspace, files, prepared.spec.inputBounds.maxFiles, prepared.spec.inputBounds.maxBytes);
                gradingRun = { ...run, artifacts: { ...run.artifacts, workspace } };
              }
              const grade = await gradeSavedRun(gradingRun, cell.task.evaluator, run.workspaceHash, cell.task.calibration,
                grader ? (command, _cwd, timeout) => grader!.validate(command, timeout) : undefined, cell.task.evaluator.graderInputsHash, operationDeadline);
              atomicJson(gradePath, grade);
            } finally { await grader?.dispose(); }
          }
        }
        const state = run.executionStatus === "interrupted" ? "interrupted" : "completed";
        append({ pair: cell.pair, attemptId, state, phase: cell.task.evaluator ? "graded" : "finalized", runPath: join("runs", attemptId, "run.json") });
        if (run.diagnostics.providerFailure.httpStatus === 401 || run.diagnostics.providerFailure.httpStatus === 403
            || /Entra .* acquisition failed/.test(run.runnerError ?? "")) {
          halt = true; errors.push("Authentication/inference permission failure stopped new admission. The selected identity was not changed.");
        }
      } catch (error) {
        append({ pair: cell.pair, attemptId, state: "error", phase: latest(cell.pair)?.phase ?? "preparation", message: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    };
    const lane = async () => {
      while (!halt && cursor < queue.length) {
        const cell = queue[cursor++];
        try {
          if (latest(cell.pair)?.state === "completed") continue;
          const prior = latest(cell.pair);
          const retained = prior && (existsSync(join(directory, "runs", prior.attemptId, "run.json"))
            || existsSync(join(directory, "runs", prior.attemptId, "execution.json")));
          const hostDeadline = retained ? clock.now() + prepared.spec.requestBounds.deadlineMs : deadline;
          while ((options.freeMemory ?? freemem)() / 1024 / 1024 < prepared.spec.bounds.minFreeMemoryMb) {
            if (clock.now() >= hostDeadline) throw new Error("Campaign host-resource admission deadline exceeded.");
            await clock.sleep(Math.min(1000, hostDeadline - clock.now()));
          }
          if (!retained && clock.now() >= deadline) throw new Error("Campaign admission deadline exceeded.");
          await perform(cell);
        }
        catch (error) { errors.push(error instanceof Error ? error.message : String(error)); halt = true; }
      }
    };
    const settled = await Promise.allSettled(Array.from({ length: prepared.spec.bounds.concurrency }, lane));
    for (const lane of settled) if (lane.status === "rejected") errors.push(lane.reason instanceof Error ? lane.reason.message : String(lane.reason));
    const evidence = campaignEvidence(directory);
    atomicJson(join(directory, "evidence.json"), evidence);
    if (errors.length) throw new Error(`Campaign stopped admitting work; active lanes drained. ${errors.join("; ")}`);
    return evidence;
  } finally { release(); }
}

export function campaignEvidence(directory: string): ReportEvidence {
  const prepared = loadPreparedCampaign(directory), events = journal(directory);
  const taskEvidence: ReportEvidence["tasks"] = prepared.tasks.map((task) => {
    const contract: RunContract = {
      contractVersion: 2, task: task.config.contract.task, candidate: task.config.contract.candidate,
      execution: task.config.contract.execution, runtime: prepared.runtime, rounds: task.config.rounds,
      executionProfile: executionProfile(task.config),
    };
    return {
      id: task.id, taskId: task.id, version: task.config.contract.task.version ?? "1", title: task.config.contract.task.title ?? task.id,
      taskType: task.config.contract.task.taskType, tags: task.config.contract.task.tags ?? [],
      taskHash: evidenceHash(task.config.contract.task), cohortHash: cohortHash(contract),
      ...(task.evaluator ? { evaluatorPolicyHash: evidenceHash(task.evaluator) } : {}),
    };
  });
  const attempts: ReportEvidence["attempts"] = [];
  const uniqueAttempts = [...new Map(events.map((event) => [event.attemptId, event])).values()];
  for (const event of uniqueAttempts) {
    const [task, candidate, repeat] = z.tuple([z.string(), z.string(), z.number().int()]).parse(JSON.parse(event.pair));
    const path = join(directory, "runs", event.attemptId, "run.json");
    if (!existsSync(path)) continue;
    const run: unknown = JSON.parse(readFileSync(path, "utf8"));
    assertBenchmarkRun(run);
    const declaredCandidate = prepared.spec.candidates.find((c) => c.id === candidate);
    if (run.runId !== event.attemptId || !declaredCandidate
        || evidenceHash(run.contract.candidate) !== evidenceHash(declaredCandidate.candidate)) throw new TypeError("Campaign run/candidate binding mismatch.");
    const gradePath = join(directory, "runs", event.attemptId, "grade.json");
    const grade = existsSync(gradePath) ? gradeSchema.parse(JSON.parse(readFileSync(gradePath, "utf8"))) : undefined;
    if (grade) {
      const taskPolicy = prepared.tasks.find((t) => t.id === task)?.evaluator;
      if (!taskPolicy || grade.policyHash !== evidenceHash(taskPolicy) || grade.evaluatorVersion !== taskPolicy.version
          || grade.checks.length !== taskPolicy.checks.length || taskPolicy.checks.some((expected) => {
            const actual = grade.checks.find((c) => c.id === expected.id);
            return !actual || actual.requirementId !== expected.requirementId || actual.category !== expected.category
              || actual.expectedType !== expected.expectedType || actual.severity !== expected.severity;
          })) throw new TypeError("Saved grade does not implement the complete declared task evaluator policy.");
    }
    const attempt = attemptFromRun(run, task, candidate, repeat, grade);
    attempt.reservation = events.find((e) => e.attemptId === event.attemptId && e.reservation)?.reservation;
    if (prepared.tasks.find((t) => t.id === task)?.evaluator && !grade) {
      attempt.acceptance = "ungraded"; attempt.policyHash = null; attempt.evaluatorVersion = null;
      attempt.requiredPassed = 0; attempt.requiredFailed = 0; attempt.advisoryFailed = 0; attempt.checkErrors = 0; attempt.requiredErrors = 0;
    }
    attempts.push(attempt);
  }
  // Journal-only attempts remain operational evidence, not invented completed runs.
  for (const event of uniqueAttempts.filter((e) => !attempts.some((a) => a.id === e.attemptId))) {
    const [task, candidate, repeat] = z.tuple([z.string(), z.string(), z.number().int()]).parse(JSON.parse(event.pair));
    const declared = taskEvidence.find((t) => t.id === task)!;
    attempts.push({
      id: event.attemptId, task, candidate, repeat, contractHash: evidenceHash({ prepared: prepared.hash, pair: event.pair }),
      promptHash: evidenceHash(prepared.tasks.find((t) => t.id === task)!.config.contract.task.prompt),
      roundsHash: evidenceHash(prepared.tasks.find((t) => t.id === task)!.config.rounds), cohortHash: declared.cohortHash,
      workspaceHash: null, startedAt: events.find((e) => e.attemptId === event.attemptId)!.at, completedAt: event.at,
      execution: event.state === "error" ? "error" : "interrupted", phase: event.phase, validation: "unavailable",
      acceptance: "ungraded", requiredPassed: 0, requiredFailed: 0, advisoryFailed: 0, checkErrors: 0,
      policyHash: null, evaluatorVersion: null, calibrated: null,
      metrics: { wallMs: null, inputTokens: null, outputTokens: null, recordedCost: null, recordedUsd: null, modelUsageRecords: 0, physicalRequests: null },
      accounting: { reservedTokens: null, rejectedRequests: null, ambiguousRequests: null },
      reservation: events.find((e) => e.attemptId === event.attemptId && e.reservation)?.reservation,
      outcome: "interrupted", wireApi: "not-recorded", authMode: "not-recorded", runtimeHash: evidenceHash(prepared.runtime), replay: [],
    });
  }
  return parseReportEvidence({
    schemaVersion: 1, campaignId: prepared.spec.id, createdAt: new Date().toISOString(), selectionPolicy: "latest-clean-completion",
    tasks: taskEvidence, candidates: prepared.spec.candidates.map((c) => ({ id: c.id, ...c.candidate })),
    repeats: prepared.spec.repeats, attempts,
    caveats: ["Immutable prepared inputs, prompts, rounds, runtime and evaluator policy define the campaign.",
      "Protective request/token/USD reservations cover all attempts, are never invoices, and are not released as estimated charges.",
      "Missing/ungraded/interrupted work is retained. No recovery until PASS. Runtime/data-plane authentication has not been inferred from token acquisition.",
      ...(!prepared.tasks.every((t) => t.config.isolation) ? ["Trusted-local tasks can access host resources and identity caches; they are not credential-isolated."] : []),
      ...(new Set(prepared.spec.candidates.map((c) => `${c.foundryProvider.type}/${c.foundryProvider.wireApi ?? "legacy"}`)).size > 1
        ? ["Candidates use different wire protocols; task-type analysis excludes protocol-mismatched cohorts."] : []),
      ...(!prepared.tasks.every((t) => t.calibration?.calibrated) ? ["Some task evaluators lack complete reference-positive, negative and equivalent-representation calibration."] : [])],
  });
}

export function reportCampaign(directory: string, output: string, options: Parameters<typeof writeReportBundle>[2] = {}): string {
  return writeReportBundle(campaignEvidence(directory), output, options);
}
export async function cleanupCampaignWorker(directory: string, recordPath: string, recoverLock = false): Promise<void> {
  loadPreparedCampaign(directory);
  const record = safeRelativePath(directory, relative(resolve(directory), resolve(recordPath)));
  const release = acquireOwnership(join(directory, "owner.lock"), recoverLock);
  try { await ControlledWorker.cleanup(record); }
  finally { release(); }
}
export function campaignStatus(directory: string) {
  const evidence = campaignEvidence(directory);
  return { campaignId: evidence.campaignId, attempts: evidence.attempts.length,
    cells: selectReportCells(evidence).map((c) => ({ task: c.task, candidate: c.candidate, repeat: c.repeat, status: c.status, selected: c.selected?.id ?? null, attempts: c.attempts.length })) };
}
