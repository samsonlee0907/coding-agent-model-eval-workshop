import { CopilotClient, RuntimeConnection, approveAll } from "@github/copilot-sdk";
import { createServer, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { asRecord } from "./json.js";
import { createIsolatedCopilotRuntimeDirectory, resolveCopilotCliPath, resolveSdkToolAllowlist, assertAdvertisedTools, startRequestSanitizingProxy } from "./runner.js";
import { readRuntimeIdentity } from "./runtime-identity.js";
import { ControlledWorker, collectSnapshot } from "./controlled-worker.js";
import { RequestGuard } from "./request-policy.js";
import { scrubFoundryEnvironment, runValidation } from "./validation.js";
import type { BenchmarkConfig } from "./types.js";
import { ToolSet } from "@github/copilot-sdk";

/**
 * A deterministic local Responses peer directs real tools; no Azure identity,
 * model or candidate input is used. Container probing is explicitly authorized.
 */
export async function verifyRuntime(config: BenchmarkConfig, allowContainer = false) {
  if (config.contract.foundryProvider.type !== "openai" || config.contract.foundryProvider.wireApi !== "responses") {
    throw new TypeError("The runtime coding probe currently covers explicit OpenAI Responses only; other protocol acceptance remains unverified.");
  }
  if (!config.contract.execution.tools.includes("read") || !config.contract.execution.tools.includes("edit")) {
    throw new TypeError("The coding probe requires declared read/edit capabilities; it will not broaden a read-only contract.");
  }
  if (config.contract.execution.mcpServers) throw new TypeError("The coding probe does not start MCP servers; verify those separately.");
  if (config.isolation && !allowContainer) throw new TypeError("Container runtime probing creates owned Docker resources. Add --allow-container-probe only after host/image approval.");
  const root = createIsolatedCopilotRuntimeDirectory();
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "input.txt"), "public fixture\n");
  const cliPath = resolveCopilotCliPath(process.env);
  const client = new CopilotClient({
    baseDirectory: root, workingDirectory: root, useLoggedInUser: false, logLevel: "none",
    env: scrubFoundryEnvironment(process.env), connection: RuntimeConnection.forStdio(cliPath ? { path: cliPath } : undefined),
    ...(config.isolation ? { mode: "empty" as const } : {}),
  });
  const guard = new RequestGuard({
    maxRequests: 16, maxRequestBytes: 1048576, maxTokens: 2000000, maxOutputTokens: 1024,
    deadlineMs: 60000, requestsPerMinute: 60, tokensPerMinute: 2000000,
  });
  let worker: ControlledWorker | null = null, calls = 0, cursor = 0, filters: string[] = [];
  const toolsUsed: string[] = [], sizes: number[] = [], failures: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const bytes = Buffer.concat(chunks); sizes.push(bytes.length);
        const payload: unknown = JSON.parse(bytes.toString("utf8"));
        assertAdvertisedTools(payload, filters);
        const action = actions[cursor++];
        if (!action) throw new Error("Runtime exceeded the deterministic probe work plan.");
        const request = action();
        if (request) toolsUsed.push(request.name);
        respond(res, ++calls, request);
      } catch (error) {
        failures.push(error instanceof Error ? error.message : "Probe failed.");
        res.writeHead(400, { "content-type": "application/json" }); res.end('{"error":{"message":"Local coding probe failed."}}');
      }
    });
  });
  const invoke = (name: string, args: object | string) => ({ name, args });
  const read = (path: string) => worker ? invoke("controlled_workspace", { operation: "read", path })
    : invoke("view", { path: join(workspace, path) });
  const create = (path: string, text: string) => worker ? invoke("controlled_workspace", { operation: "write", path, content: text })
    : filters.includes("builtin:apply_patch") ? invoke("apply_patch", `*** Begin Patch\n*** Add File: ${path}\n+${text.trimEnd()}\n*** End Patch\n`)
      : invoke("create", { path: join(workspace, path), file_text: text });
  const edit = (path: string, before: string, after: string) => worker ? invoke("controlled_workspace", { operation: "write", path, content: after + "\n" })
    : filters.includes("builtin:apply_patch") ? invoke("apply_patch", `*** Begin Patch\n*** Update File: ${path}\n@@\n-${before}\n+${after}\n*** End Patch\n`)
      : invoke("edit", { path: join(workspace, path), old_str: before, new_str: after });
  const actions = [
    () => read("input.txt"),
    () => create("result.txt", "FIRST\n"), () => create("answer.json", '{"sum":0}\n'), () => null,
    () => edit("result.txt", "FIRST", "OK"), () => edit("answer.json", '{"sum":0}', '{"sum":16}'),
    () => read("result.txt"), () => null,
    () => worker ? invoke("controlled_workspace", { operation: "list", path: "." }) : invoke("glob", { pattern: "*.txt", paths: workspace }),
    () => null,
  ];
  let proxy: Awaited<ReturnType<typeof startRequestSanitizingProxy>> | null = null;
  let sessionId: string | null = null;
  const workerRecord = join(root, "worker.json");
  let workerDisposed = false;
  try {
    if (config.isolation) {
      try {
        worker = await ControlledWorker.create(config.isolation,
          collectSnapshot(workspace, config.isolation.maxFiles, config.isolation.maxBytes), workerRecord, undefined, undefined, guard.deadline);
      } catch (error) {
        if (existsSync(workerRecord)) throw new Error(`Runtime worker creation failed; owned recovery record retained at ${workerRecord}.`, { cause: error });
        throw error;
      }
    }
    await client.start();
    const catalog = await client.rpc.tools.list({ model: config.contract.candidate.model });
    filters = worker ? new ToolSet().addCustom("controlled_workspace").toArray()
      : resolveSdkToolAllowlist(config.contract.execution.tools, undefined, catalog.tools.map((tool) => tool.name));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Local coding peer did not start.");
    proxy = await startRequestSanitizingProxy(`http://127.0.0.1:${address.port}`, (body) => body,
      { guard, wireApi: "responses", validateTools: (payload) => assertAdvertisedTools(payload, filters) });
    const session = await client.createSession({
      model: config.contract.candidate.model, workingDirectory: worker ? root : workspace,
      availableTools: filters, ...(worker ? { tools: [worker.tool(config.contract.execution.tools)] } : {}),
      streaming: true, enableSessionStore: false, reasoningEffort: config.contract.execution.reasoningEffort,
      onPermissionRequest: approveAll, systemMessage: { mode: "replace", content: "Execute the deterministic public fixture tools in this disposable workspace only." },
      provider: { type: "openai", wireApi: "responses", baseUrl: proxy.baseUrl, apiKey: "local-fixture-key" },
    });
    sessionId = session.sessionId;
    await session.rpc.tools.initializeAndValidate();
    assertAdvertisedTools(await session.rpc.tools.getCurrentMetadata(), filters);
    const backend = (await session.getEvents()).find((event) => event.type === "session.start");
    const unsubscribe = session.on((event) => {
      if (event.type === "tool.execution_complete" && event.data.success === false) failures.push("Actual runtime tool execution failed.");
    });
    try {
      for (const [prompt, mode] of [["Create two public output fixtures.", "immediate"], ["Edit both fixtures to their final values.", "enqueue"],
        ["Inspect fixed large input: " + "x".repeat(300000), "immediate"]] as const) {
        await session.sendAndWait({ prompt, mode }, Math.max(1, guard.deadline - Date.now()));
      }
    } finally { unsubscribe(); }
    if (!guard.cleanlySettled() || failures.length || cursor !== actions.length) throw new Error(`Runtime coding probe failed: ${failures.join(" ") || "Incomplete work or transport."}`);
    const command = `node -e "const f=require('node:fs');if(!/^OK\\r?\\n$/.test(f.readFileSync('result.txt','utf8'))||JSON.parse(f.readFileSync('answer.json','utf8')).sum!==16)process.exit(1)"`;
    const validation = worker ? await worker.validate(command, 5000) : await runValidation(command, workspace, 5000);
    if (validation.exitCode !== 0 || validation.timedOut || validation.errorMessage) throw new Error("Deterministic coding-probe validation failed.");
    let exported = workspace;
    if (worker) { exported = join(root, "export"); await worker.snapshot(exported); }
    const resultText = readFileSync(join(exported, "result.txt"), "utf8");
    const answerText = readFileSync(join(exported, "answer.json"), "utf8");
    if (!/^OK\r?\n$/.test(resultText) || JSON.parse(answerText).sum !== 16) {
      throw new Error(`Actual file creation/multi-round editing did not produce the required public fixture bytes: ${JSON.stringify({ resultText, answerText })}.`);
    }
    return {
      schemaVersion: 1, passed: true, runtime: readRuntimeIdentity(),
      reportedBackendVersion: backend ? asRecord(backend.data).copilotVersion : null,
      mode: config.isolation ? "container" : "trusted-local", image: config.isolation?.image ?? null,
      filters, toolsUsed, fileHashes: ["result.txt", "answer.json"].map((path) => ({
        path, sha256: createHash("sha256").update(readFileSync(join(exported, path))).digest("hex"),
      })),
      fixedRounds: 3, modes: ["immediate", "enqueue", "immediate"], validation: "pass",
      maximumRequestBytes: Math.max(...sizes), requestAccounting: guard.accounting,
      cloudInference: "not-dispatched", liveAuthDeployment: "not-verified",
    };
  } finally {
    try { if (sessionId) await client.deleteSession(sessionId); }
    finally {
      try { await client.stop(); }
      finally {
        try { await proxy?.stop(); await new Promise<void>((resolve, reject) => server.close((error) => error && "code" in error && error.code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve())); }
        finally {
          try { await worker?.dispose(); workerDisposed = worker !== null; }
          catch (error) { throw new Error(`Runtime probe cleanup failed; owned recovery record retained at ${workerRecord}.`, { cause: error }); }
          finally { if (!existsSync(workerRecord) || workerDisposed) rmSync(root, { recursive: true, force: true }); }
        }
      }
    }
  }
}

function respond(res: ServerResponse, number: number, request: { name: string; args: object | string } | null): void {
  const id = `response-${number}`, call = `call-${number}`;
  const item = request ? typeof request.args === "string"
    ? { id: call, call_id: call, type: "custom_tool_call", name: request.name, input: request.args, status: "completed" }
    : { id: call, call_id: call, type: "function_call", name: request.name, arguments: JSON.stringify(request.args), status: "completed" }
    : { id: `message-${number}`, type: "message", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: "Public fixture step complete.", annotations: [] }] };
  const response = { id, object: "response", created_at: Math.floor(Date.now() / 1000), status: "completed", output: [item],
    model: "local-peer", usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
  const events = [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress" } },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ];
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const [sequence_number, event] of events.entries()) res.write(`event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`);
  res.end();
}
