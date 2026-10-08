import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createServer, request as httpRequest } from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CopilotClient, RuntimeConnection, ToolSet, defineTool } from "@github/copilot-sdk";
import { bearerTokenProvider } from "../src/auth.js";
import { runBenchmark, startRequestSanitizingProxy } from "../src/runner.js";
import { RequestGuard } from "../src/request-policy.js";
import { fixtureConfig } from "./fixtures/revamp.js";
import { readRuntimeIdentity } from "../src/runtime-identity.js";

test("compiled runtime locates pinned SDK metadata without a TypeScript loader", () => {
  const module = new URL("../dist/runtime-identity.js", import.meta.url).href;
  const code = `import { installedSdkVersion } from ${JSON.stringify(module)}; console.log(installedSdkVersion());`;
  assert.equal(execFileSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 15000 }).trim(), "1.0.10-preview.0");
});

test("pinned SDK uses refreshed bearer, large multi-round Responses and controlled-only tools without cloud calls", { timeout: 60000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "benchmark-sdk-fixture-"));
  const authorizations: string[] = [], sizes: number[] = [];
  const routes: string[] = [], toolCounts: number[] = [];
  let token = "fixture-token-one";
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      authorizations.push(String(req.headers.authorization));
      sizes.push(Buffer.concat(chunks).length);
      routes.push(req.url ?? "");
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      toolCounts.push(body.tools?.length ?? 0);
      const id = `response-${authorizations.length}`, message = `msg-${authorizations.length}`;
      const content = [{ type: "output_text", text: "fixture completed", annotations: [] }];
      const item = { id: message, type: "message", status: "completed", role: "assistant", content };
      const response = { id, object: "response", created_at: Math.floor(Date.now() / 1000), status: "completed",
        model: "fixture-model", output: [item], usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105,
          input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
      res.writeHead(200, { "content-type": "text/event-stream" });
      const events = [
        { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
        { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
        { type: "response.content_part.added", item_id: message, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
        { type: "response.output_text.delta", item_id: message, output_index: 0, content_index: 0, delta: "fixture completed" },
        { type: "response.output_text.done", item_id: message, output_index: 0, content_index: 0, text: "fixture completed" },
        { type: "response.content_part.done", item_id: message, output_index: 0, content_index: 0, part: content[0] },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response },
      ];
      for (const [sequence_number, event] of events.entries()) res.write(`event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const guard = new RequestGuard();
  const proxy = await startRequestSanitizingProxy(`http://127.0.0.1:${address.port}`, (body) => body, { wireApi: "responses", guard });
  const client = new CopilotClient({ mode: "empty", baseDirectory: root, workingDirectory: root, useLoggedInUser: false,
    connection: RuntimeConnection.forStdio(), logLevel: "none" });
  try {
    await client.start();
    const session = await client.createSession({
      model: "fixture-model", availableTools: [], workingDirectory: root, streaming: true, enableSessionStore: false,
      systemMessage: { mode: "replace", content: "Reply with fixture completed, without tools." },
      provider: { type: "openai", wireApi: "responses", baseUrl: proxy.baseUrl,
        bearerTokenProvider: bearerTokenProvider({ mode: "entra", credential: "azure-cli" }, {
          async getToken() { return { token, expiresOnTimestamp: Date.now() + 60000 }; },
        }) },
    });
    await session.sendAndWait({ prompt: "Large fixture input: " + "x".repeat(300000) }, 20000);
    token = "fixture-token-two";
    await session.sendAndWait({ prompt: "Second fixed follow-up." }, 20000);
    assert.equal(authorizations.length, 2);
    assert.deepEqual(authorizations, ["Bearer fixture-token-one", "Bearer fixture-token-two"]);
    assert.ok(sizes[0] > 192 * 1024); assert.ok(sizes[1] > sizes[0]);
    assert.deepEqual(routes, ["/responses", "/responses"]); assert.deepEqual(toolCounts, [0, 0]);
    assert.equal(guard.accounting.physicalRequests, 2); assert.equal(guard.accounting.ambiguousRequests, 0);
    assert.equal(guard.cleanlySettled(), true);
    await client.deleteSession(session.sessionId);
    const controlled = await client.createSession({
      model: "fixture-model", availableTools: new ToolSet().addCustom("controlled_workspace").toArray(),
      tools: [defineTool("controlled_workspace", { description: "Fixture-only controlled workspace.", parameters: { type: "object", properties: {} },
        handler: async () => "fixture" })],
      workingDirectory: root, streaming: true, enableSessionStore: false,
      provider: { type: "openai", wireApi: "responses", baseUrl: proxy.baseUrl, apiKey: "fixture-key" },
    });
    await controlled.sendAndWait({ prompt: "Reply without invoking tools." }, 20000);
    assert.equal(toolCounts.at(-1), 1);
    assert.equal(guard.accounting.physicalRequests, 3); assert.equal(guard.cleanlySettled(), true);
    await client.deleteSession(controlled.sessionId);
    let intercepted = 0;
    const transport = mock.method(https, "request", (target: URL, options, callback) => {
      intercepted++;
      assert.equal(target.hostname, "fixture.openai.azure.com");
      return httpRequest(new URL(target.pathname + target.search, `http://127.0.0.1:${address.port}`), options, callback);
    });
    syncBuiltinESMExports();
    const oldEndpoint = process.env.FOUNDRY_ENDPOINT, oldKey = process.env.FOUNDRY_API_KEY;
    process.env.FOUNDRY_ENDPOINT = "https://fixture.services.ai.azure.com"; process.env.FOUNDRY_API_KEY = "fixture-key";
    try {
      const workspace = join(root, "main-api-input"); mkdirSync(workspace);
      const config = fixtureConfig(workspace, "main-api-task", "fixture-model");
      config.contract.runtime = readRuntimeIdentity();
      config.artifactsDirectory = join(root, "main-api-artifacts");
      const run = await runBenchmark(config, { runId: "complete-fixture" });
      assert.equal(run.runnerError, null, JSON.stringify({ intercepted, routes, error: run.runnerError, accounting: run.requestAccounting, diagnostics: run.diagnostics }));
      assert.equal(run.executionStatus, "completed");
      assert.deepEqual(run.contract.runtime, config.contract.runtime);
      assert.equal(typeof run.diagnostics.reportedBackendVersion, "string");
      assert.equal(run.validation?.exitCode, 0); assert.equal(run.contract.foundryProvider?.wireApi, "responses");
      assert.equal(run.requestAccounting?.physicalRequests, 1);
      assert.equal(routes[3], "/openai/v1/responses");
      const checkpoint = JSON.parse(readFileSync(join(run.artifacts.directory, "execution.json"), "utf8"));
      assert.equal(checkpoint.executionComplete, true);
      const dispatched = intercepted;
      await assert.rejects(() => runBenchmark({ ...config, contract: { ...config.contract,
        runtime: { ...config.contract.runtime, cliSha256: "0".repeat(64) } } }, { runId: "changed-runtime-fixture" }), /identity differs/);
      assert.equal(intercepted, dispatched);
      const originalStop = CopilotClient.prototype.stop;
      const shutdown = mock.method(CopilotClient.prototype, "stop", async function () {
        await originalStop.call(this);
        throw new Error("fixture runtime shutdown interrupted");
      });
      try {
        await assert.rejects(() => runBenchmark(config, { runId: "draining-fixture" }), /shutdown interrupted/);
        const draining = JSON.parse(readFileSync(join(config.artifactsDirectory, "draining-fixture", "execution.json"), "utf8"));
        assert.equal(draining.executionComplete, false); assert.equal(draining.requestAccounting.physicalRequests, 1);
      } finally { shutdown.mock.restore(); }
    } finally {
      transport.mock.restore(); syncBuiltinESMExports();
      if (oldEndpoint === undefined) delete process.env.FOUNDRY_ENDPOINT; else process.env.FOUNDRY_ENDPOINT = oldEndpoint;
      if (oldKey === undefined) delete process.env.FOUNDRY_API_KEY; else process.env.FOUNDRY_API_KEY = oldKey;
    }
  } finally {
    await client.stop();
    await proxy.stop();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(root, { recursive: true, force: true });
  }
});
