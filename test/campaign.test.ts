import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, appendFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { prepareCampaign, runCampaign, campaignStatus, campaignEvidence, loadPreparedCampaign } from "../src/campaign.js";
import { atomicJson, acquireOwnership, appendJournal, readJournal } from "../src/durable.js";
import { EventCollector } from "../src/event-collector.js";
import { fixtureConfig, fixtureRun, fixtureRuntime } from "./fixtures/revamp.js";
import { evidenceHash, selectReportCells } from "../src/evidence.js";
import { collectSnapshot, snapshotHash, writeSnapshot } from "../src/controlled-worker.js";
import { readRuntimeIdentity } from "../src/runtime-identity.js";
import { runValidation } from "../src/validation.js";
import type { BenchmarkConfig, BenchmarkRun } from "../src/types.js";
import type { BenchmarkRunOptions } from "../src/runner.js";

function prepare(root: string, candidates = 2, overrides: Record<string, unknown> = {}) {
  mkdirSync(join(root, "source")); writeFileSync(join(root, "source", "input.txt"), "immutable input");
  atomicJson(join(root, "task.json"), fixtureConfig(join(root, "source")));
  const spec = {
    schemaVersion: 1, id: "custom-campaign", tasks: [{ id: "custom-task", config: "task.json" }],
    candidates: Array.from({ length: candidates }, (_, i) => ({ id: `c${i}`, candidate: { provider: "openai", model: `custom-${i}` }, foundryProvider: { type: "openai", wireApi: "responses" } })),
    repeats: 1, inputBounds: { maxFiles: 100, maxBytes: 1024 * 1024 },
    requestBounds: { maxRequests: 10, maxRequestBytes: 1024 * 1024, maxTokens: 10000, maxOutputTokens: 100, deadlineMs: 30000, requestsPerMinute: 100, tokensPerMinute: 100000 },
    bounds: { concurrency: 2, minFreeMemoryMb: 0, maxAttemptsPerCell: 2, deadlineMs: 120000,
      maxRequests: 100, maxReservedTokens: 100000, maxReservationUsd: 10, reservationUsdPerMillionTokens: 10 },
    ...overrides,
  };
  atomicJson(join(root, "spec.json"), spec);
  const directory = join(root, "campaign");
  prepareCampaign(join(root, "spec.json"), directory, fixtureRuntime);
  return directory;
}
function fakeRunner(onRun: () => void = () => undefined, verdict: "pass" | "fail" = "pass") {
  return async (config: BenchmarkConfig, options: BenchmarkRunOptions): Promise<BenchmarkRun> => {
    onRun(); options.onPhase?.("running", { runId: options.runId!, artifactsDirectory: config.artifactsDirectory! });
    const run = fixtureRun(options.runId!, config, verdict);
    atomicJson(join(run.artifacts.directory, "run.json"), run);
    return run;
  };
}

test("compiled public campaign resume grades retained outputs under long state roots without provider dispatch", async (t) => {
  const publicTask = JSON.parse(readFileSync(join("examples", "custom-campaign", "json-task.json"), "utf8"));
  const publicPolicy = JSON.parse(readFileSync(join("examples", "custom-campaign", "json-evaluator.json"), "utf8"));
  for (const control of ["public-pass", "setup-spawn-error"]) {
    const root = mkdtempSync(join(tmpdir(), "bt-public-grade-"));
    try {
      mkdirSync(join(root, "json-input"));
      writeFileSync(join(root, "json-input", "numbers.json"), '{"numbers":[3,5,8]}\n');
      atomicJson(join(root, "task.json"), publicTask);
      atomicJson(join(root, "policy.json"), control === "public-pass" ? publicPolicy : { ...publicPolicy, setupCommand: "node\u0000" });
      const spec = {
        schemaVersion: 1, id: "offline-public-grading",
        tasks: [{ id: publicTask.contract.task.id, config: "task.json", evaluator: "policy.json" }],
        candidates: [{ id: "saved-local-fixture", candidate: { provider: "openai", model: "saved-local-fixture" },
          foundryProvider: { type: "openai", wireApi: "responses" } }],
        repeats: 1, inputBounds: { maxFiles: 100, maxBytes: 1024 * 1024 },
        requestBounds: { maxRequests: 1, maxRequestBytes: 1024 * 1024, maxTokens: 10000, maxOutputTokens: 100,
          deadlineMs: 30000, requestsPerMinute: 1, tokensPerMinute: 10000 },
        bounds: { concurrency: 1, minFreeMemoryMb: 0, maxAttemptsPerCell: 1, deadlineMs: 60000,
          maxRequests: 1, maxReservedTokens: 10000, maxReservationUsd: 1, reservationUsdPerMillionTokens: 1 },
      };
      atomicJson(join(root, "spec.json"), spec);
      const directory = join(root, "s".repeat(Math.max(1, 173 - root.length - 1)));
      const prepared = prepareCampaign(join(root, "spec.json"), directory, readRuntimeIdentity());
      const attemptId = randomUUID();
      const config = structuredClone(prepared.tasks[0].config);
      config.contract.candidate = prepared.spec.candidates[0].candidate;
      config.contract.foundryProvider = prepared.spec.candidates[0].foundryProvider;
      config.workspacePath = join(directory, "attempts", attemptId, "input");
      config.artifactsDirectory = join(directory, "runs");
      writeSnapshot(config.workspacePath, prepared.tasks[0].files, 100, 1024 * 1024);
      writeFileSync(join(config.workspacePath, "answer.json"), '{"sum":16}\r\n');
      assert.equal(config.workspacePath.length, 225);
      const validation = await runValidation(publicTask.contract.task.validationCommand, config.workspacePath, 10000);
      assert.equal(validation.exitCode, 0);
      const oldGradingCopy = join(directory, "runs", attemptId, `grading-input-${randomUUID()}`);
      assert.equal(oldGradingCopy.length, 266);
      writeSnapshot(oldGradingCopy, collectSnapshot(config.workspacePath, 100, 1024 * 1024), 100, 1024 * 1024);
      const oldSpawn = spawnSync(process.execPath, ["-e", "process.exit(0)"], { cwd: oldGradingCopy, timeout: 10000, encoding: "utf8" });
      if (process.platform === "win32") { assert.equal(oldSpawn.status, null); assert.equal(oldSpawn.error?.code, "ENOENT"); }
      const oldValidation = await runValidation(publicPolicy.checks[0].command, oldGradingCopy, 5000);
      if (process.platform === "win32") {
        assert.equal(oldValidation.exitCode, null);
        assert.ok(oldValidation.failures?.some((failure) => failure.phase === "spawn" && failure.code === "ENOENT"));
      } else assert.equal(oldValidation.exitCode, 0);
      rmSync(oldGradingCopy, { recursive: true });
      const run = fixtureRun(attemptId, config, "ungraded");
      run.validation = validation; run.workspaceHash = snapshotHash(collectSnapshot(config.workspacePath, 100, 1024 * 1024));
      run.requestAccounting = { physicalRequests: 0, reservedTokens: 0, ambiguousRequests: 0, rejectedRequests: 0 };
      atomicJson(join(run.artifacts.directory, "run.json"), run);
      const pair = JSON.stringify([publicTask.contract.task.id, "saved-local-fixture", 0]);
      appendJournal(join(directory, "journal.ndjson"), { schemaVersion: 1, sequence: 1, at: new Date().toISOString(),
        pair, attemptId, state: "finalizing", phase: "grading" });
      const before = readFileSync(join(run.artifacts.directory, "run.json"));
      const cli = spawnSync(process.execPath, [resolve("dist", "campaign-cli.js"), "resume", "--directory", directory, "--allow-paid"],
        { encoding: "utf8", timeout: 30000, maxBuffer: 65536,
          env: { ...process.env, FOUNDRY_API_KEY: "", FOUNDRY_ENDPOINT: "" } });
      assert.equal(cli.error, undefined); assert.equal(cli.status, 0, cli.stderr);
      assert.doesNotMatch(cli.stderr, /Unhandled|ENOTCONN/);
      const grade = JSON.parse(readFileSync(join(run.artifacts.directory, "grade.json"), "utf8"));
      assert.equal(grade.checks[0].status, control === "public-pass" ? "pass" : "error");
      if (control === "setup-spawn-error") assert.deepEqual(grade.checks[0].diagnostic, {
        stage: "setup", exitCode: null, timedOut: false, failures: [{ phase: "spawn", code: "ERR_INVALID_ARG_VALUE" }],
      });
      assert.equal(grade.workspaceHash, run.workspaceHash);
      assert.equal(campaignEvidence(directory).attempts[0].metrics.physicalRequests, 0);
      assert.equal(campaignStatus(directory).cells[0].status, control === "public-pass" ? "pass" : "error");
      assert.equal(readJournal(join(directory, "journal.ndjson"), (value) => {
        assert.ok(value !== null && typeof value === "object" && "state" in value);
        return value.state;
      }).at(-1), "completed");
      assert.deepEqual(readFileSync(join(run.artifacts.directory, "run.json")), before);
      assert.equal(snapshotHash(collectSnapshot(config.workspacePath, 100, 1024 * 1024)), run.workspaceHash);
      assert.equal(createHash("sha256").update(readFileSync(join(config.workspacePath, "answer.json"))).digest("hex"),
        "2cf63b303bd261432bc7bd5a0c8412c4f5341c0e96c306f08a49e193ee183118");
      assert.ok(readdirSync(run.artifacts.directory).every((path) => !path.startsWith("grading-input-")));
      t.diagnostic(JSON.stringify({ control, node: process.version, platform: process.platform,
        originalCwdCharacters: config.workspacePath.length, originalValidationExit: validation.exitCode,
        oldGradingCwdCharacters: oldGradingCopy.length, oldSpawnErrorCode: oldSpawn.error?.code ?? null,
        handledLongCwdFailures: oldValidation.failures ?? [],
        publicResumeExit: cli.status, persistedGradeStatus: grade.checks[0].status,
        publicRequiredCheck: grade.checks[0].id, policyHash: grade.policyHash,
        originalWorkspaceUnchanged: true, savedExecutionPhysicalRequests: 0,
      }));
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("custom campaign pins inputs and skips clean completed content FAILs on resume", async () => {
  const root = mkdtempSync(join(tmpdir(), "benchmark-campaign-"));
  try {
    const directory = prepare(root); let calls = 0;
    const options = { allowPaid: true, runtime: fixtureRuntime, run: fakeRunner(() => calls++, "fail") };
    await runCampaign(directory, options);
    writeFileSync(join(root, "source", "input.txt"), "changed original, not prepared input");
    await runCampaign(directory, options);
    assert.equal(calls, 2);
    assert.deepEqual(campaignStatus(directory).cells.map((c) => c.status), ["fail", "fail"]);
    assert.equal(loadPreparedCampaign(directory).tasks[0].files[0].content, Buffer.from("immutable input").toString("base64"));
    assert.equal(selectReportCells(campaignEvidence(directory)).length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("campaign ownership, runtime pins and paid approval fail closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "benchmark-ownership-"));
  try {
    const directory = prepare(root);
    const oversized = join(root, "oversized"); mkdirSync(oversized);
    assert.throws(() => prepare(oversized, 101, { repeats: 1000 }), /publication bound/);
    await assert.rejects(() => runCampaign(directory, { allowPaid: false, runtime: fixtureRuntime }), /allow-paid/);
    await assert.rejects(() => runCampaign(directory, { allowPaid: true, runtime: { ...fixtureRuntime, cliVersion: "changed" } }), /identity changed/);
    const release = acquireOwnership(join(directory, "owner.lock"));
    try { await assert.rejects(() => runCampaign(directory, { allowPaid: true, runtime: fixtureRuntime, recoverLock: true }), /active process/); }
    finally { release(); }
    const prepared = JSON.parse(readFileSync(join(directory, "prepared.json"), "utf8")); prepared.tasks[0].config.rounds.push({ prompt: "drift" });
    atomicJson(join(directory, "prepared.json"), prepared);
    assert.throws(() => loadPreparedCampaign(directory), /hash mismatch/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("private graders are separately pinned, reject source drift and cannot overlap candidate inputs", () => {
  const root = mkdtempSync(join(tmpdir(), "benchmark-private-assets-"));
  try {
    prepare(root, 1);
    mkdirSync(join(root, "grader")); writeFileSync(join(root, "grader", "check.cjs"), "process.exit(0)");
    const config = fixtureConfig(join(root, "source"));
    config.isolation = { mode: "container", image: `fixture@sha256:${"a".repeat(64)}`, memoryMb: 128, cpus: 1,
      maxFiles: 100, maxBytes: 1024 * 1024, commandTimeoutMs: 5000 };
    atomicJson(join(root, "task.json"), config);
    const hash = snapshotHash(collectSnapshot(join(root, "grader"), 100, 1024 * 1024));
    atomicJson(join(root, "policy.json"), { schemaVersion: 1, version: "1", timeoutMs: 5000, graderInputsHash: hash,
      checks: [{ id: "custom-check", requirementId: "public-requirement", category: "user-defined", expectedType: "artifact",
        severity: "required", command: "node /grader/check.cjs" }] });
    const spec = JSON.parse(readFileSync(join(root, "spec.json"), "utf8"));
    spec.tasks[0] = { ...spec.tasks[0], evaluator: "policy.json", graderInputs: "grader" };
    atomicJson(join(root, "spec.json"), spec);
    const directory = join(root, "private-campaign");
    const prepared = prepareCampaign(join(root, "spec.json"), directory, fixtureRuntime);
    assert.equal(prepared.tasks[0].evaluator?.graderInputsHash, hash);
    assert.deepEqual(prepared.tasks[0].files.map((file) => file.path), ["input.txt"]);
    assert.deepEqual(prepared.tasks[0].graderFiles?.map((file) => file.path), ["check.cjs"]);
    writeFileSync(join(root, "grader", "check.cjs"), "process.exit(1)");
    assert.equal(loadPreparedCampaign(directory).tasks[0].graderFiles?.[0].content, Buffer.from("process.exit(0)").toString("base64"));
    assert.throws(() => prepareCampaign(join(root, "spec.json"), join(root, "drifted"), fixtureRuntime), /exact private grader input hash/);
    assert.equal(existsSync(join(root, "drifted")), false);
    spec.tasks[0].graderInputs = "source"; atomicJson(join(root, "spec.json"), spec);
    assert.throws(() => prepareCampaign(join(root, "spec.json"), join(root, "overlap"), fixtureRuntime), /must be disjoint/);
    assert.equal(existsSync(join(root, "overlap")), false);
    prepared.tasks[0].graderFiles![0].content = Buffer.from("changed embedded oracle").toString("base64");
    const { hash: _hash, ...body } = prepared;
    atomicJson(join(directory, "prepared.json"), { ...body, hash: evidenceHash(body) });
    assert.throws(() => loadPreparedCampaign(directory), /snapshot|hash|binding/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("crash with saved run finalizes on restart without inference, unknown dispatch does not replay", async () => {
  const root = mkdtempSync(join(tmpdir(), "benchmark-resume-"));
  try {
    const directory = prepare(root, 1); let calls = 0;
    await assert.rejects(() => runCampaign(directory, {
      allowPaid: true, runtime: fixtureRuntime, run: async (config, options) => {
        calls++;
        const run = await fakeRunner()(config, options);
        throw new Error(`Crash after immutable run checkpoint ${run.runId}`);
      },
    }), /Crash/);
    await runCampaign(directory, { allowPaid: true, runtime: fixtureRuntime, run: fakeRunner(() => calls++) });
    assert.equal(calls, 1); assert.equal(campaignStatus(directory).cells[0].status, "pass");
    const other = join(root, "other"); mkdirSync(other);
    const unknownDirectory = prepare(other, 1);
    const unknown = { allowPaid: true, runtime: fixtureRuntime, run: async () => { calls++; throw new Error("Crash before durable completion"); } };
    await assert.rejects(() => runCampaign(unknownDirectory, unknown), /Crash/);
    await assert.rejects(() => runCampaign(unknownDirectory, unknown), /dispatch-safe checkpoint/);
    assert.equal(calls, 2); assert.equal(campaignStatus(unknownDirectory).cells[0].status, "interrupted");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("retained-output recovery works after inference admission expired and preserves reservations", async () => {
  const root = mkdtempSync(join(tmpdir(), "benchmark-expired-resume-"));
  try {
    const directory = prepare(root, 1);
    let now = Date.now(), calls = 0;
    const clock = { now: () => now, async sleep(ms: number) { now += ms; } };
    await assert.rejects(() => runCampaign(directory, { allowPaid: true, runtime: fixtureRuntime, clock,
      run: async (config, options) => { calls++; await fakeRunner()(config, options); throw new Error("saved output, finalization interrupted"); } }), /interrupted/);
    assert.equal(campaignEvidence(directory).attempts[0].reservation?.tokens, 10000);
    now += 120001;
    await runCampaign(directory, { allowPaid: true, runtime: fixtureRuntime, clock, run: fakeRunner(() => calls++) });
    assert.equal(calls, 1); assert.equal(campaignStatus(directory).cells[0].status, "pass");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("budget failure drains active lanes and low memory queues until the absolute deadline", async () => {
  const root = mkdtempSync(join(tmpdir(), "benchmark-admission-"));
  try {
    const bounds = { concurrency: 2, minFreeMemoryMb: 0, maxAttemptsPerCell: 1, deadlineMs: 120000,
      maxRequests: 10, maxReservedTokens: 100000, maxReservationUsd: 10, reservationUsdPerMillionTokens: 10 };
    const directory = prepare(root, 2, { bounds }); let drained = false;
    await assert.rejects(() => runCampaign(directory, {
      allowPaid: true, runtime: fixtureRuntime, run: async (config, options) => {
        await new Promise((r) => setTimeout(r, 20)); drained = true; return fakeRunner()(config, options);
      },
    }), /budget exhausted/);
    assert.equal(drained, true); assert.equal(campaignStatus(directory).cells.filter((c) => c.selected).length, 1);
    const other = join(root, "memory"); mkdirSync(other);
    const lowMemory = prepare(other, 1, { bounds: { ...bounds, minFreeMemoryMb: 2000, deadlineMs: 3000 } });
    let now = Date.now(), calls = 0;
    await assert.rejects(() => runCampaign(lowMemory, {
      allowPaid: true, runtime: fixtureRuntime, run: fakeRunner(() => calls++), freeMemory: () => 1024,
      clock: { now: () => now, async sleep(ms) { now += ms; } },
    }), /deadline/);
    assert.equal(calls, 0); assert.equal(campaignStatus(lowMemory).cells[0].status, "missing");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("append reopening and torn final lines preserve prior sequences and quarantine damage", () => {
  const root = mkdtempSync(join(tmpdir(), "benchmark-journal-"));
  try {
    const raw = join(root, "raw.ndjson"), normalized = join(root, "normalized.ndjson");
    const first = new EventCollector(raw, normalized); first.captureRunnerEvent("runner.first");
    appendFileSync(raw, '{"schemaVersion":1,"sequence":2');
    const second = new EventCollector(raw, normalized);
    assert.equal(second.captureRunnerEvent("runner.second").sequence, 2);
    assert.equal(second.events().length, 2);
    assert.ok(readdirSync(root).some((f) => f.startsWith("raw.ndjson.torn-")));
    const journal = join(root, "state.ndjson");
    appendJournal(journal, { id: 1 }); appendFileSync(journal, '{"id":');
    const before = readFileSync(journal);
    assert.deepEqual(readJournal(journal, (v) => v, false), [{ id: 1 }]);
    assert.deepEqual(readFileSync(journal), before);
    readJournal(journal, (v) => v);
    appendFileSync(journal, "broken\n");
    assert.throws(() => readJournal(journal, (v) => v), /JSON/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
