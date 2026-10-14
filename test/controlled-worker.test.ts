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
  assert.match(text, /target=\/workspace,volume-nocopy/);
  assert.doesNotMatch(text, /type=bind|docker\.sock|FOUNDRY|AZURE|--privileged|--publish|host\.docker/);
});
test("export freezes candidate writes and reads only an owned read-only volume; private grader files stay separate", async () => {
  const root = mkdtempSync(join(tmpdir(), "benchmark-export-"));
  const calls: string[][] = [], imports: Array<{ root: string; body: string }> = [];
  let owner = "", paused = false;
  const docker: DockerExecutor = async (args, input) => {
    calls.push([...args]);
    const label = args.find((a) => a.startsWith("benchmark.owner=")); if (label) owner = label.slice("benchmark.owner=".length);
    if (args[0] === "volume" && args[1] === "inspect") return { code: 0, stdout: owner, stderr: "" };
    if (args[0] === "run" && args[args.indexOf("--name") + 1]?.endsWith("-owner")) {
      return { code: 0, stdout: JSON.stringify({ uid: 1000, gid: 1000, mode: 0o755 }), stderr: "" };
    }
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
    if (args[0] === "run" && args[args.indexOf("--name") + 1]?.endsWith("-owner")) {
      return { code: 0, stdout: JSON.stringify({ uid: 1000, gid: 1000, mode: 0o755 }), stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  try {
    const worker = await ControlledWorker.create(policy, [file()], join(root, "worker.json"), docker);
    const tool = worker.tool(["read", "edit"]);
    await assert.rejects(async () => tool.handler!({ operation: "command", command: "cat /host" }, { sessionId: "s", toolCallId: "t", toolName: tool.name }), /denied/);
    await assert.rejects(async () => tool.handler!({ operation: "read", path: "../host" }, { sessionId: "s", toolCallId: "t", toolName: tool.name }), /relative/);
    await assert.rejects(async () => tool.handler!({ operation: "write", path: "result.txt" }, { sessionId: "s", toolCallId: "t", toolName: tool.name }), /content is required/);
    await assert.rejects(async () => tool.handler!({ operation: "write", path: "result.txt", content: "\u2603".repeat(400000) },
      { sessionId: "s", toolCallId: "t", toolName: tool.name }), /byte bound/);
    await tool.handler!({ operation: "write", path: "result.txt", content: "OK" }, { sessionId: "s", toolCallId: "t", toolName: tool.name });
    assert.ok(calls.at(-1)?.includes("write"));
    assert.ok(calls.at(-1)?.some((arg) => arg.includes("fs.writeFileSync(p,s)")));
    const before = calls.length; owner = "someone-else";
    await assert.rejects(() => worker.dispose(), /ownership mismatch/);
    assert.ok(calls.slice(before).every((args) => args[0] !== "rm"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("initializer uses actual copied-up volume owner without capabilities or candidate identity changes", async () => {
  for (const identity of [{ uid: 0, gid: 0 }, { uid: 1000, gid: 1000 }, { uid: 10001, gid: 10001 }]) {
    const root = mkdtempSync(join(tmpdir(), "benchmark-worker-owner-"));
    const calls: string[][] = [];
    let owner = "";
    const docker: DockerExecutor = async args => {
      calls.push([...args]);
      const label = args.find(arg => arg.startsWith("benchmark.owner="));
      if (label) owner = label.slice("benchmark.owner=".length);
      if (args[0] === "volume" && args[1] === "inspect") return { code: 0, stdout: owner, stderr: "" };
      if (args[0] === "run" && args[args.indexOf("--name") + 1]?.endsWith("-owner")) {
        assert.ok(args.some(arg => arg.endsWith("target=/workspace,readonly")));
        assert.equal(args[args.indexOf("--user") + 1], "0");
        assert.match(args.at(-1)!, /lstatSync/);
        assert.equal(calls.at(-2)?.[1], "inspect");
        return { code: 0, stdout: JSON.stringify({ ...identity, mode: 0o755 }), stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    try {
      const record = join(root, "worker.json");
      await ControlledWorker.create(policy, [file()], record, docker);
      const runs = calls.filter(args => args[0] === "run");
      assert.equal(runs.length, 3);
      assert.equal(runs[1][runs[1].indexOf("--user") + 1], `${identity.uid}:${identity.gid}`);
      assert.ok(runs[1].some(arg => arg.endsWith("target=/workspace,volume-nocopy")));
      assert.ok(runs[1].includes("chmod"));
      assert.deepEqual(runs[1].slice(-2), ["0777", "/workspace"]);
      assert.equal(runs[2][runs[2].indexOf("--user") + 1], "1000:1000");
      assert.ok(runs[2].some(arg => arg.endsWith("target=/workspace,volume-nocopy")));
      assert.equal(runs[0][runs[0].indexOf("--workdir") + 1], "/");
      assert.equal(runs[1][runs[1].indexOf("--workdir") + 1], "/");
      for (const args of runs) {
        assert.equal(args[args.indexOf("--network") + 1], "none");
        assert.equal(args[args.indexOf("--cap-drop") + 1], "ALL");
        assert.ok(args.includes("--read-only") && args.includes("no-new-privileges"));
        assert.ok(!args.includes("--cap-add") && !args.includes("--privileged"));
      }
      assert.deepEqual(JSON.parse(readFileSync(record, "utf8")).workspaceOwnership, { ...identity, mode: 0o755 });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});
test("failed or invalid ownership inspection and owner chmod fail closed with exact owned cleanup", async () => {
  for (const failure of ["owner-label", "inspect-failure", "not-json", "invalid-uid", "chmod"] as const) {
    const root = mkdtempSync(join(tmpdir(), "benchmark-worker-owner-failure-"));
    const calls: string[][] = [];
    let owner = "", name = "", volume = "", volumeExists = false, labelsChecked = 0;
    const docker: DockerExecutor = async args => {
      calls.push([...args]);
      const label = args.find(arg => arg.startsWith("benchmark.owner="));
      if (label) { owner = label.slice("benchmark.owner=".length); name = `benchmark-${owner}`; volume = `${name}-workspace`; }
      if (args[0] === "volume" && args[1] === "create") volumeExists = true;
      if (args[0] === "volume" && args[1] === "inspect") {
        return { code: 0, stdout: failure === "owner-label" && labelsChecked++ === 0 ? "unrelated-owner" : owner, stderr: "" };
      }
      if (args[0] === "run") {
        const helper = args[args.indexOf("--name") + 1];
        if (helper.endsWith("-owner")) return { code: failure === "inspect-failure" ? 1 : 0,
          stdout: failure === "not-json" ? "not JSON" : JSON.stringify({ uid: failure === "invalid-uid" ? "0:0" : 10001, gid: 10001, mode: 0o755 }),
          stderr: "Workspace volume must be a directory" };
        if (helper.endsWith("-init")) return { code: 1, stdout: "", stderr: "Operation not permitted" };
        assert.fail("Candidate must not start after initializer failure.");
      }
      if (args[0] === "container" && args[1] === "ls") return { code: 0, stdout: `${name}-owner\n${name}-unrelated\n`, stderr: "" };
      if (args[0] === "inspect") return { code: 0, stdout: owner, stderr: "" };
      if (args[0] === "volume" && args[1] === "ls") return { code: 0, stdout: volumeExists ? volume : "", stderr: "" };
      if (args[0] === "volume" && args[1] === "rm") volumeExists = false;
      return { code: 0, stdout: "", stderr: "" };
    };
    try {
      await assert.rejects(() => ControlledWorker.create(policy, [file()], join(root, "worker.json"), docker));
      assert.equal(volumeExists, false);
      assert.deepEqual(calls.filter(args => args[0] === "rm").map(args => args.at(-1)), [`${name}-owner`]);
      assert.ok(!calls.some(args => args[0] === "run" && args.includes("-d")));
      assert.ok(!calls.some(args => args.includes("--cap-add") || args.includes("--privileged")));
      if (failure !== "chmod") assert.ok(!calls.some(args => args.includes("chmod")));
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});
