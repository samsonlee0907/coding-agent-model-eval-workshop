import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, appendFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareCampaign, runCampaign, campaignStatus, campaignEvidence, loadPreparedCampaign } from "../src/campaign.js";
import { atomicJson, acquireOwnership, appendJournal, readJournal } from "../src/durable.js";
import { EventCollector } from "../src/event-collector.js";
import { fixtureConfig, fixtureRun, fixtureRuntime } from "./fixtures/revamp.js";
import { evidenceHash, selectReportCells } from "../src/evidence.js";
import { collectSnapshot, snapshotHash } from "../src/controlled-worker.js";
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
