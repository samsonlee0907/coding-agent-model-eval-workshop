import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type ServerResponse } from "node:http";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
import { benchmarkSessionOptions, resolveCopilotCliPath, resolveSdkToolAllowlist,
  assertAdvertisedTools, startRequestSanitizingProxy } from "../src/runner.js";
import { scrubFoundryEnvironment } from "../src/validation.js";
import { RequestGuard } from "../src/request-policy.js";
import { fixtureConfig } from "./fixtures/revamp.js";
import { exactContentTool, exactContentToolName } from "../src/exact-content.js";
import { benchmarkConfigSchema } from "../src/config-schema.js";
import { compareRunContracts, immutableContractHash } from "../src/contract.js";
import { fixtureRun } from "./fixtures/revamp.js";
import { runValidation } from "../src/validation.js";
import { parseEvaluatorPolicy } from "../src/task-evaluator.js";
import { verifyRuntime } from "../src/runtime-verification.js";

test("exact UTF-8 writes are explicit, bounded, workspace-scoped and do not write through hardlinks or junctions", () => {
  const root = mkdtempSync(join(tmpdir(), "bt-exact-writes-"));
  const workspace = join(root, "workspace"), outside = join(root, "outside");
  mkdirSync(workspace); mkdirSync(outside);
  try {
    const tool = exactContentTool(workspace);
    const invoke = (input: unknown) => tool.handler!(input, { sessionId: "fixture", toolCallId: "call", toolName: tool.name });
    invoke({ path: "result.txt", content: "OK\r\n" });
    assert.equal(readFileSync(join(workspace, "result.txt")).length, 4);
    assert.deepEqual(invoke({ path: "result.txt", content: "OK" }), {
      bytes: 2, sha256: "565339bc4d33d72817b583024112eb7f5cdf3e5eef0252d6ec1b9c9a94e12bb3",
    });
    assert.deepEqual(readFileSync(join(workspace, "result.txt")), Buffer.from("OK"));
    invoke({ path: "nested/empty.txt", content: "" });
    assert.equal(readFileSync(join(workspace, "nested", "empty.txt")).length, 0);
    const unicode = "caf\u00e9\r\n\u2603";
    invoke({ path: "unicode.txt", content: unicode });
    assert.deepEqual(readFileSync(join(workspace, "unicode.txt")), Buffer.from(unicode, "utf8"));
    for (const path of ["../outside/x", "C:\\outside\\x", "/outside", "\\\\host\\share", "x:stream", "x.", "NUL.txt",
      ".git/config", ".benchmark-runs/state.json", "nested/../x", ""]) {
      assert.throws(() => invoke({ path, content: "denied" }));
    }
    assert.throws(() => invoke({ path: "missing.txt" }));
    assert.throws(() => invoke({ path: "missing.txt", content: "OK", command: "shell" }));
    assert.throws(() => invoke({ path: "missing.txt", content: "\ud800" }), /valid Unicode/);
    assert.throws(() => invoke({ path: "missing.txt", content: "\u2603".repeat(400000) }), /byte bound/);
    assert.equal(existsSync(join(workspace, "missing.txt")), false);
    writeFileSync(join(outside, "protected.txt"), "unchanged");
    linkSync(join(outside, "protected.txt"), join(workspace, "hardlink.txt"));
    invoke({ path: "hardlink.txt", content: "OK" });
    assert.equal(readFileSync(join(outside, "protected.txt"), "utf8"), "unchanged");
    symlinkSync(outside, join(workspace, "junction"), process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => invoke({ path: "junction/protected.txt", content: "denied" }), /symlinks\/junctions/);
    assert.equal(readFileSync(join(outside, "protected.txt"), "utf8"), "unchanged");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("exact-content capability is schema-validated and immutable comparison drift without widening read-only", () => {
  const config = fixtureConfig("unused", "exact-policy", "fixture-model");
  const before = structuredClone(fixtureRun("original", config, "pass").contract);
  assert.ok(!("exactContentEdits" in benchmarkConfigSchema.parse(config).contract.execution));
  config.contract.execution.exactContentEdits = true;
  config.contract.execution.tools = ["read"];
  assert.throws(() => benchmarkConfigSchema.parse(config), /requires the edit capability/);
  assert.throws(() => resolveSdkToolAllowlist(["read"], undefined, ["view", "glob"], true), /edit capability/);
  config.contract.execution.tools = ["read", "edit"];
  assert.equal(benchmarkConfigSchema.parse(config).contract.execution.exactContentEdits, true);
  const after = fixtureRun("new-profile", config, "pass").contract;
  assert.notEqual(immutableContractHash(before), immutableContractHash(after));
  assert.ok(compareRunContracts(before, after).drift.some((entry) => entry.path === "execution.exactContentEdits"));
  assert.deepEqual(resolveSdkToolAllowlist(["read", "edit"], undefined, ["view", "glob", "apply_patch"], true),
    ["builtin:view", "builtin:glob", "builtin:apply_patch", `custom:${exactContentToolName}`]);
  assert.throws(() => assertAdvertisedTools({ tools: [{ name: "view" }, { name: "glob" }, { name: "apply_patch" }] },
    ["builtin:view", "builtin:glob", "builtin:apply_patch", `custom:${exactContentToolName}`]), /missing write_file_exact/);
});

type Call = { name: string; args: object | string } | null;
function respond(res: ServerResponse, index: number, action: Call) {
  const id = `exact-${index}`, call = `call-${index}`;
  const item = action ? typeof action.args === "string"
    ? { id: call, call_id: call, type: "custom_tool_call", name: action.name, input: action.args, status: "completed" }
    : { id: call, call_id: call, type: "function_call", name: action.name, arguments: JSON.stringify(action.args), status: "completed" }
    : { id: `message-${index}`, type: "message", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: "Public exact-content fixture complete.", annotations: [] }] };
  const response = { id, object: "response", status: "completed", output: [item], model: "fixture-peer",
    usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } };
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ]) res.write(`data: ${JSON.stringify(event)}\n\n`);
  res.end();
}

test("selected native patch reports success but cannot remove the terminal newline with EOF positioning", { timeout: 60000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "bt-native-bytes-"));
  const config = fixtureConfig(root, "exact-byte-control", "gpt-5.2-codex");
  config.contract.execution.tools = ["read", "edit"];
  const cliPath = resolveCopilotCliPath(process.env);
  const client = new CopilotClient({ baseDirectory: root, workingDirectory: root, useLoggedInUser: false,
    env: scrubFoundryEnvironment(process.env), logLevel: "none",
    connection: RuntimeConnection.forStdio(cliPath ? { path: cliPath } : undefined) });
  const actions: Call[] = [
    { name: "view", args: { path: join(root, "input.txt") } },
    { name: "apply_patch", args: "*** Begin Patch\n*** Add File: result.txt\n+OK\n*** End Patch\n" }, null,
    { name: "apply_patch", args: "*** Begin Patch\n*** Update File: result.txt\n@@\n-OK\n+OK\n*** End of File\n*** End Patch" }, null,
    { name: "apply_patch", args: "*** Begin Patch\n*** Delete File: result.txt\n*** Add File: result.txt\n+OK\n*** End Patch" }, null,
  ];
  let cursor = 0, filters: string[] = [];
  const guard = new RequestGuard({ maxRequests: 7, maxRequestBytes: 1048576, maxTokens: 1000000,
    maxOutputTokens: 2000, deadlineMs: 60000, requestsPerMinute: 60, tokensPerMinute: 1000000 });
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      assertAdvertisedTools(JSON.parse(Buffer.concat(chunks).toString()), filters);
      assert.ok(cursor < actions.length, "No unbounded fake-provider tool loop.");
      respond(res, cursor + 1, actions[cursor++]);
    });

  });
  let proxy: Awaited<ReturnType<typeof startRequestSanitizingProxy>> | undefined;
  try {
    writeFileSync(join(root, "input.txt"), "Public exact-byte control.\n");
    await client.start();
    const catalog = await client.rpc.tools.list({ model: config.contract.candidate.model });
    filters = resolveSdkToolAllowlist(config.contract.execution.tools, undefined, catalog.tools.map((tool) => tool.name));
    assert.deepEqual(filters, ["builtin:view", "builtin:glob", "builtin:apply_patch"]);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address !== "string");
    proxy = await startRequestSanitizingProxy(`http://127.0.0.1:${address.port}`, (body) => body, { guard, wireApi: "responses" });
    const session = await client.createSession(benchmarkSessionOptions(config, {
      type: "openai", wireApi: "responses", baseUrl: proxy.baseUrl, apiKey: "local-fixture-only",
    }, root, filters));
    await session.rpc.tools.initializeAndValidate();
    assertAdvertisedTools(await session.rpc.tools.getCurrentMetadata(), filters);
    for (const prompt of ["Read input.txt and create result.txt containing OK with an optional trailing newline.",
      "Remove the trailing newline so result.txt contains exactly the two bytes OK.",
      "Recreate result.txt containing exactly OK without any trailing newline."]) {
      await session.sendAndWait({ prompt }, 20000);
      const bytes = readFileSync(join(root, "result.txt"));
      assert.match(bytes.toString(), /^OK\r?\n$/);
      assert.notDeepEqual(bytes, Buffer.from("OK"));
    }
    const completions = (await session.getEvents()).filter((event) => event.type === "tool.execution_complete");
    assert.equal(completions.length, 4);
    assert.ok(completions.every((event) => event.data.success));
    assert.equal(guard.accounting.physicalRequests, 7); assert.equal(guard.accounting.ambiguousRequests, 0);
    assert.equal(guard.cleanlySettled(), true);
    await client.deleteSession(session.sessionId);
  } finally {
    await client.stop(); await proxy?.stop();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("selected SDK/CLI uses native tools plus declared exact writer for LF creation and two-byte fixed-round repair", { timeout: 60000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "bt-exact-runtime-"));
  const example = JSON.parse(readFileSync(new URL("../examples/custom-campaign/exact-text-task.json", import.meta.url), "utf8"));
  const config = benchmarkConfigSchema.parse({ ...example, workspacePath: root });
  config.contract.candidate.model = "gpt-5.2-codex";
  const cliPath = resolveCopilotCliPath(process.env);
  const client = new CopilotClient({ baseDirectory: root, workingDirectory: root, useLoggedInUser: false,
    env: scrubFoundryEnvironment(process.env), logLevel: "none",
    connection: RuntimeConnection.forStdio(cliPath ? { path: cliPath } : undefined) });
  const actions: Call[] = [
    { name: "view", args: { path: join(root, "input.txt") } },
    { name: "apply_patch", args: "*** Begin Patch\n*** Add File: result.txt\n+OK\n*** End Patch\n" },
    { name: exactContentToolName, args: { path: "result.txt", content: "OK\n" } }, null,
    { name: "view", args: { path: join(root, "result.txt") } },
    { name: exactContentToolName, args: { path: "result.txt", content: "OK" } }, null,
  ];
  let cursor = 0, filters: string[] = [];
  const guard = new RequestGuard({ maxRequests: 7, maxRequestBytes: 131072, maxTokens: 500000,
    maxOutputTokens: 2000, deadlineMs: 60000, requestsPerMinute: 60, tokensPerMinute: 1000000 });
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString());
      assertAdvertisedTools(payload, filters);
      assert.equal(payload.max_output_tokens, 2000); assert.equal(payload.reasoning.effort, "high");
      assert.ok(!payload.tools.some((tool: { name: string }) => /shell|powershell|bash/.test(tool.name)));
      assert.ok(cursor < actions.length);
      respond(res, cursor + 1, actions[cursor++]);
    });
  });
  let proxy: Awaited<ReturnType<typeof startRequestSanitizingProxy>> | undefined;
  try {
    writeFileSync(join(root, "input.txt"), "The public task requests a text artifact containing OK.\n");
    await client.start();
    const catalog = await client.rpc.tools.list({ model: config.contract.candidate.model });
    filters = resolveSdkToolAllowlist(config.contract.execution.tools, undefined, catalog.tools.map((tool) => tool.name), true);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address !== "string");
    proxy = await startRequestSanitizingProxy(`http://127.0.0.1:${address.port}`, (body) => body, {
      guard, wireApi: "responses", validateTools: (payload) => assertAdvertisedTools(payload, filters),
    });
    const session = await client.createSession(benchmarkSessionOptions(config, {
      type: "openai", wireApi: "responses", baseUrl: proxy.baseUrl, apiKey: "local-fixture-only",
    }, root, filters));
    await session.rpc.tools.initializeAndValidate();
    assertAdvertisedTools(await session.rpc.tools.getCurrentMetadata(), filters);
    await session.sendAndWait({ prompt: config.contract.task.prompt, mode: "immediate" }, 20000);
    assert.deepEqual(readFileSync(join(root, "result.txt")), Buffer.from("OK\n"));
    const evaluator = parseEvaluatorPolicy(JSON.parse(readFileSync(new URL("../examples/custom-campaign/exact-text-evaluator.json", import.meta.url), "utf8")));
    assert.equal((await runValidation(evaluator.checks.find((check) => check.id === "fixed-followup")!.command, root, 5000)).exitCode, 1);
    await session.sendAndWait({ prompt: config.rounds[0].prompt, mode: config.rounds[0].mode }, 20000);
    assert.deepEqual(readFileSync(join(root, "result.txt")), Buffer.from("OK"));
    for (const check of evaluator.checks) assert.equal((await runValidation(check.command, root, 5000)).exitCode, 0);
    assert.equal((await runValidation(config.contract.task.validationCommand, root, 5000)).exitCode, 0);
    const completions = (await session.getEvents()).filter((event) => event.type === "tool.execution_complete");
    assert.equal(completions.length, 5); assert.ok(completions.every((event) => event.data.success));
    assert.equal(cursor, 7); assert.equal(guard.accounting.physicalRequests, 7);
    assert.equal(guard.accounting.ambiguousRequests, 0); assert.equal(guard.cleanlySettled(), true);
    await client.deleteSession(session.sessionId);
    const proof = await verifyRuntime(config);
    assert.equal(proof.textEditSemantics.scope, "exact-utf8-control");
    assert.equal(proof.textEditSemantics.resultBytes, 2);
    assert.equal(proof.textEditSemantics.terminalNewline, false);
    assert.ok(proof.toolsUsed.includes(exactContentToolName));
    assert.ok(proof.toolsUsed.includes("apply_patch"));
    assert.ok(!proof.filters.some((tool) => /shell|powershell|bash/.test(tool)));
  } finally {
    await client.stop(); await proxy?.stop();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
