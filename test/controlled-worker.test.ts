import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { controlledContainerArgs, ControlledWorker, validateSnapshot, writeSnapshot, type DockerExecutor } from "../src/controlled-worker.js";
import { collectSnapshot, snapshotHash } from "../src/controlled-worker.js";

const policy = { mode: "container" as const, image: `vendor/runtime@sha256:${"a".repeat(64)}`, memoryMb: 512, cpus: 1, maxFiles: 100, maxBytes: 1024 * 1024, commandTimeoutMs: 5000 };
const file = (path = "result.txt") => ({ path, bytes: 6, sha256: createHash("sha256").update("result").digest("hex"), content: Buffer.from("result").toString("base64") });
test("controlled container uses a digest, nonroot, no network/host binds and finite resource bounds", () => {
  const args = controlledContainerArgs(policy, "owned", "owned-workspace", "owner");
  const text = args.join(" ");
  assert.match(text, /--network none/); assert.match(text, /--user 1000:1000/); assert.match(text, /--cap-drop ALL/);
  assert.match(text, /--read-only/); assert.match(text, /--memory 512m/); assert.match(text, /--pids-limit 128/);
  assert.match(text, /type=volume/);
  assert.doesNotMatch(text, /type=bind|docker\.sock|FOUNDRY|AZURE|--privileged|--publish|host\.docker/);
});
test("export freezes candidate writes and reads only an owned read-only volume; private grader files stay separate", async () => {
  const root = mkdtempSync(join(tmpdir(), "benchmark-export-"));
  const calls: string[][] = [], imports: Array<{ root: string; body: string }> = [];
  let owner = "", paused = false;
  const docker: DockerExecutor = async (args, input) => {
    calls.push([...args]);
    const label = args.find((a) => a.startsWith("benchmark.owner=")); if (label) owner = label.slice("benchmark.owner=".length);
    if (args[0] === "inspect") {
      const format = args[args.indexOf("--format") + 1];
      return { code: 0, stdout: format === "{{.State.Paused}}" ? String(paused)
        : format === "{{json .State}}" ? JSON.stringify({ Running: true, Paused: paused }) : owner, stderr: "" };
    }
    if (args[0] === "pause") paused = true;
    if (args[0] === "exec" && input) imports.push({ root: args.at(-1)!, body: input });
    if (args[0] === "run" && args.includes(`${JSON.parse(readFileSync(join(root, "worker.json"), "utf8")).name}-export`)) {
      assert.equal(paused, true); assert.ok(args.some((a) => a.includes("target=/workspace,readonly")));
      return { code: 0, stdout: JSON.stringify([file()]), stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  try {
    const worker = await ControlledWorker.create(policy, [file("input.txt")], join(root, "worker.json"), docker, [file("private-check.cjs")]);
    assert.deepEqual(imports.map((i) => i.root), ["/workspace", "/grader"]);
    assert.ok(!imports[0].body.includes("private-check"));
    await worker.snapshot(join(root, "snapshot"));
    assert.equal(readFileSync(join(root, "snapshot", "result.txt"), "utf8"), "result");
    assert.ok(!calls.some((a) => a[0] === "unpause"));
    const reopened = await ControlledWorker.reopen(join(root, "worker.json"), docker);
    await reopened.snapshot(join(root, "recovered"));
    assert.equal(calls.filter((a) => a[0] === "pause").length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("partial creation cleans only owned named resources, never prefix-matching unrelated containers", async () => {
  const root = mkdtempSync(join(tmpdir(), "benchmark-worker-cleanup-"));
  const calls: string[][] = []; let owner = "", name = "", volume = "", volumeExists = false;
  const docker: DockerExecutor = async (args) => {
    calls.push([...args]);
    const label = args.find((a) => a.startsWith("benchmark.owner="));
    if (label) { owner = label.slice("benchmark.owner=".length); name = `benchmark-${owner}`; volume = `${name}-workspace`; }
    if (args[0] === "volume" && args[1] === "create") volumeExists = true;
    if (args[0] === "run") return { code: 1, stdout: "", stderr: "fixture creation failure" };
    if (args[0] === "container" && args[1] === "ls") return { code: 0, stdout: `${name}-unrelated\n`, stderr: "" };
    if (args[0] === "volume" && args[1] === "ls") return { code: 0, stdout: volumeExists ? volume : "", stderr: "" };
    if (args[0] === "volume" && args[1] === "inspect") return { code: 0, stdout: owner, stderr: "" };
    if (args[0] === "volume" && args[1] === "rm") volumeExists = false;
    return { code: 0, stdout: "", stderr: "" };
  };
  try {
    const record = join(root, "worker.json");
    await assert.rejects(() => ControlledWorker.create(policy, [file()], record, docker), /creation failure/);
    assert.equal(volumeExists, false); assert.ok(existsSync(record));
    assert.ok(!calls.some((a) => a[0] === "rm"));
    await ControlledWorker.cleanup(record, docker);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("bounded snapshot import/export rejects traversal, reserved names, collisions and bad hashes", () => {
  for (const path of ["../x", "/abs", "C:\\host", "nested/../x", "NUL.txt", "x.", "node_modules/private", "a//b"]) {
    assert.throws(() => validateSnapshot([file(path)], 100, 10000), /Unsafe/);
  }
  assert.throws(() => validateSnapshot([file("a/x"), file("A/y")], 100, 10000), /colliding/);
  assert.throws(() => validateSnapshot([{ ...file(), sha256: "b".repeat(64) }], 100, 10000), /binding/);
  assert.throws(() => validateSnapshot([file()], 100, 5), /bound/);
  const root = mkdtempSync(join(tmpdir(), "benchmark-snapshot-"));
  try {
    const expected = writeSnapshot(join(root, "workspace"), [file()], 100, 10000);
    assert.equal(snapshotHash(collectSnapshot(join(root, "workspace"), 100, 10000)), expected);
    assert.equal(readFileSync(join(root, "workspace", "result.txt"), "utf8"), "result");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("worker candidate tools are confined and cleanup verifies exact ownership", async () => {
  const root = mkdtempSync(join(tmpdir(), "benchmark-worker-"));
  const calls: string[][] = []; let owner = "";
  const docker: DockerExecutor = async (args) => {
    calls.push([...args]);
    const label = args.find((a) => a.startsWith("benchmark.owner=")); if (label) owner = label.split("=")[1];
    if (args[0] === "inspect" || args[0] === "volume" && args[1] === "inspect") return { code: 0, stdout: owner, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  try {
    const worker = await ControlledWorker.create(policy, [file()], join(root, "worker.json"), docker);
    const tool = worker.tool(["read", "edit"]);
    await assert.rejects(async () => tool.handler!({ operation: "command", command: "cat /host" }, { sessionId: "s", toolCallId: "t", toolName: tool.name }), /denied/);
    await assert.rejects(async () => tool.handler!({ operation: "read", path: "../host" }, { sessionId: "s", toolCallId: "t", toolName: tool.name }), /relative/);
    const before = calls.length; owner = "someone-else";
    await assert.rejects(() => worker.dispose(), /ownership mismatch/);
    assert.ok(calls.slice(before).every((args) => args[0] !== "rm"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
