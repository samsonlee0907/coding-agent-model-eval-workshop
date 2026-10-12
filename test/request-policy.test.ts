import assert from "node:assert/strict";
import test from "node:test";
import { createServer, request } from "node:http";
import { RequestGuard, DeploymentAdmission, DispatchError, canRetryRequest, retryDelay } from "../src/request-policy.js";
import { startRequestSanitizingProxy, dispatchBenchmarkWorkRequests, benchmarkWorkRequests, createRunDiagnostics } from "../src/runner.js";
import { ProviderStream, ProviderTerminalError, providerTerminal } from "../src/provider-stream.js";
import { deriveMetrics } from "../src/metrics.js";
import { event } from "./fixtures/events.js";
import { fixtureRuntime } from "./fixtures/revamp.js";

test("physical request recovery is only for explicit 429 rejection and honors retry headers", () => {
  assert.equal(canRetryRequest("explicitly-rejected", 429), true);
  for (const [certainty, status] of [["possibly-processed", 429], ["not-dispatched", 403], ["explicitly-rejected", 503]] as const) assert.equal(canRetryRequest(certainty, status), false);
  assert.equal(retryDelay(new Headers({ "retry-after-ms": "1250" }), 0, 0), 1250);
  assert.equal(retryDelay(new Headers({ "retry-after": "2" }), 0, 0), 2000);
  assert.equal(retryDelay(new Headers({ "retry-after": "Thu, 08 Oct 2026 00:00:01 GMT" }), 0, Date.parse("2026-10-08T00:00:00Z")), 1000);
});
test("per-deployment RPM/TPM windows queue using fake time and fail before unsafe dispatch", async () => {
  let now = 0; const sleeps: number[] = [];
  const admission = new DeploymentAdmission({ now: () => now, async sleep(ms) { sleeps.push(ms); now += ms; } });
  await admission.admit("a", 500, 2, 1000, 120001);
  await admission.admit("a", 500, 2, 1000, 120001);
  await admission.admit("b", 800, 1, 1000, 120001);
  await admission.admit("a", 100, 2, 1000, 120001);
  assert.deepEqual(sleeps, [60000]);
  await assert.rejects(() => admission.admit("a", 1001, 2, 1000, 120001), /TPM/);
});
test("guard distinguishes physical dispatch, protective reservations and ambiguous spend", () => {
  assert.throws(() => new RequestGuard(JSON.parse('{"maxRequests":1,"maxDurationMs":5000}')), /maxTokens|deadlineMs/);
  assert.equal(new RequestGuard(undefined, 0, 3600000).deadline, 3600000);
  const guard = new RequestGuard({ maxRequests: 1, maxRequestBytes: 1000, maxTokens: 1000, maxOutputTokens: 50, deadlineMs: 5000, requestsPerMinute: 2, tokensPerMinute: 1000 });
  guard.reserve(300, 150); guard.ambiguous();
  assert.deepEqual(guard.accounting, { physicalRequests: 1, reservedTokens: 150, ambiguousRequests: 1, rejectedRequests: 0 });
  assert.throws(() => guard.reserve(1, 1), /closed/);
});
test("individually unfit conservative request reports shape/capacity before any physical dispatch", async () => {
  let calls = 0;
  const host = await upstream((_req, res) => { calls++; res.end(); });
  const guard = new RequestGuard({ maxRequests: 10, maxRequestBytes: 1048576, maxTokens: 100000, maxOutputTokens: 2000,
    deadlineMs: 900000, requestsPerMinute: 1, tokensPerMinute: 8000 });
  const captured: Array<import("../src/types.js").JsonRecord> = [];
  const proxy = await startRequestSanitizingProxy(host.base, (body) => body, {
    guard, retries: 3, capture(type, data) { if (type === "runner.provider_bridge_error") captured.push(data); },
  });
  try {
    const reply = await post(proxy.baseUrl, { model: "fixture", input: "x".repeat(24000) });
    assert.equal(reply.status, 400);
    assert.match(await reply.text(), /conservative reservation \d+ exceeds.*8000.*SDK system\/context\/tool schemas.*Pacing\/cooldown cannot shrink/);
    assert.equal(calls, 0); assert.equal(guard.accounting.physicalRequests, 0);
    assert.equal(guard.accounting.reservedTokens, 0); assert.equal(guard.accounting.ambiguousRequests, 0);
    assert.equal(captured[0].certainty, "not-dispatched"); assert.equal(captured[0].phase, "admission");
  } finally { await proxy.stop(); await host.close(); }
});
test("whole work requests never retry, even when a downstream call was explicitly rejected", async () => {
  let sent = 0;
  await assert.rejects(() => dispatchBenchmarkWorkRequests(benchmarkWorkRequests("task", []), async () => {
    sent++; throw new DispatchError("later 429 after tools executed", "explicitly-rejected", 429);
  }, 5, () => undefined), /429/);
  assert.equal(sent, 1);
});
async function upstream(handler: Parameters<typeof createServer>[0]) {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  return { server, base: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((r, reject) => server.close((e) => e ? reject(e) : r())) };
}
const post = (url: string, body = { model: "fixture", input: "safe fixture" }) => fetch(`${url}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
test("bridge recovers rejected 429 once, records both physical dispatches and prevents hidden replay", async () => {
  let calls = 0;
  const host = await upstream((_req, res) => {
    calls++; res.writeHead(calls === 1 ? 429 : 200, { "content-type": "application/json", "retry-after-ms": "1" });
    res.end(calls === 1 ? '{"error":{"code":"rate_limit"}}' : '{"id":"fixture","status":"completed","output":[]}');
  });
  const guard = new RequestGuard();
  const proxy = await startRequestSanitizingProxy(host.base, (b) => b, { guard, retries: 2 });
  try {
    assert.equal((await post(proxy.baseUrl)).status, 200);
    assert.equal(calls, 2); assert.equal(guard.accounting.physicalRequests, 2); assert.equal(guard.accounting.rejectedRequests, 1);
    assert.equal((await post(proxy.baseUrl)).status, 400); assert.equal(calls, 2);
  } finally { await proxy.stop(); await host.close(); }
});
test("partial 200, ambiguous 5xx and permanent auth/quota failures close the lane instead of replaying", async () => {
  for (const mode of ["partial", "auth", "quota", "server"] as const) {
    let calls = 0;
    const host = await upstream((_req, res) => {
      calls++;
      if (mode === "partial") { res.writeHead(200, { "content-type": "text/event-stream" }); res.end('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'); }
      else { res.writeHead(mode === "auth" ? 403 : mode === "server" ? 503 : 429, { "content-type": "application/json", "retry-after-ms": "1" }); res.end(mode === "quota" ? '{"error":{"code":"insufficient_quota"}}' : '{"error":"private-auth-diagnostic"}'); }
    });
    const guard = new RequestGuard();
    const proxy = await startRequestSanitizingProxy(host.base, (b) => b, { guard, retries: 3 });
    try {
      await post(proxy.baseUrl).then((response) => response.text()).catch(() => undefined);
      const again = await post(proxy.baseUrl, { model: "fixture", input: "another work request" }); await again.text();
      assert.equal(calls, 1); assert.equal(again.status, 400);
      assert.equal(guard.accounting.ambiguousRequests, mode === "partial" || mode === "server" ? 1 : 0);
    } finally { await proxy.stop(); await host.close(); }
  }
});
test("bounded media requests fail before dispatch instead of inventing token estimates", async () => {
  let calls = 0;
  const host = await upstream((_req, res) => { calls++; res.end(); });
  const guard = new RequestGuard({ maxRequests: 3, maxRequestBytes: 10000, maxTokens: 10000, maxOutputTokens: 128,
    deadlineMs: 5000, requestsPerMinute: 5, tokensPerMinute: 10000 });
  const proxy = await startRequestSanitizingProxy(host.base, (body) => body, { guard });
  try {
    const response = await fetch(`${proxy.baseUrl}/responses`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fixture", input: [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AA==" }] }] }) });
    assert.equal(response.status, 400); assert.equal(calls, 0); assert.equal(guard.accounting.physicalRequests, 0);
    assert.equal(guard.cleanlySettled(), false);
  } finally { await proxy.stop(); await host.close(); }
});
test("large bounded requests are forwarded without the historical session-only 192 KiB limit", async () => {
  let size = 0;
  const host = await upstream((req, res) => {
    req.on("data", (chunk) => size += chunk.length); req.on("end", () => { res.writeHead(200); res.end('{"id":"fixture","status":"completed","output":[]}'); });
  });
  const proxy = await startRequestSanitizingProxy(host.base, (b) => b);
  try {
    await (await post(proxy.baseUrl, { model: "fixture", input: "a".repeat(300000) })).text();
    assert.ok(size > 192 * 1024);
  } finally { await proxy.stop(); await host.close(); }
});
test("malformed JSON and malformed terminal SSE 200 responses close all subsequent work", async () => {
    for (const mode of ["json", "sse"] as const) {
      let calls = 0;
      const host = await upstream((_req, res) => {
        calls++;
        res.writeHead(200, { "content-type": mode === "json" ? "application/json" : "text/event-stream" });
        res.end(mode === "json" ? '{"unexpected":"not an inference result"}' : "data: malformed-json\n\ndata: [DONE]\n\n");
      });
      const guard = new RequestGuard(), proxy = await startRequestSanitizingProxy(host.base, (b) => b, { guard });
      try {
        await post(proxy.baseUrl).then((response) => response.text()).catch(() => undefined);
        assert.equal((await post(proxy.baseUrl, { model: "fixture", input: "different request" })).status, 400);
        assert.equal(calls, 1); assert.equal(guard.accounting.ambiguousRequests, 1);
      } finally { await proxy.stop(); await host.close(); }
    }
  });
test("large valid terminal SSE events are not silently truncated at 8 KiB", async () => {
    const host = await upstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const text = `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: ["x".repeat(100000)] } })}\n\n`;
      res.write(text.slice(0, 50000)); setTimeout(() => res.end(text.slice(50000)), 1);
    });
    const guard = new RequestGuard(), proxy = await startRequestSanitizingProxy(host.base, (b) => b, { guard });
    try { await (await post(proxy.baseUrl)).text(); assert.equal(guard.accounting.ambiguousRequests, 0); }
    finally { await proxy.stop(); await host.close(); }
});

test("SSE parses split UTF-8, CR/LF and multiline event data rather than transport chunks", () => {
    const text = '\uFEFF: keepalive\r\n' +
      'event: response.completed\rdata: {"type":"response.completed",\r\n' +
      'data: "response":{"status":"completed","output":["Unicode: \u4e2d"]}}\r\n\r\n';
    const parser = new ProviderStream("/responses");
    for (const byte of Buffer.from(text)) parser.push(Buffer.from([byte]));
    assert.doesNotThrow(() => parser.finish());
    for (const stream of ['data: [DONE]\n\n', 'data: {"type":"response.completed"}\n\n',
      'data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n',
      'data: {"type":"response.failed"}\n\n']) {
      const invalid = new ProviderStream("/responses");
      assert.throws(() => { invalid.push(Buffer.from(stream)); invalid.finish(); }, /Provider/);
    }
});

test("bridge forwards valid multiline terminal SSE, certifies before downstream completion and retains phase diagnostics", async () => {
    const host = await upstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end('data: {"type":"response.completed",\r\ndata: "response":{"status":"completed","output":[]}}\r\n\r\n');
    });
    const guard = new RequestGuard(), proxy = await startRequestSanitizingProxy(host.base, (b) => b, { guard });
    try {
      assert.match(await (await post(proxy.baseUrl)).text(), /response.completed/);
      assert.equal(guard.cleanlySettled(), true);
    } finally { await proxy.stop(); await host.close(); }
    const errors: Array<Record<string, unknown>> = [];
    const failed = await upstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"type":"response.output_text.delta","delta":"public fixture"}\n\n');
      setTimeout(() => res.destroy(), 5);
    });
    const stopped = new RequestGuard(), broken = await startRequestSanitizingProxy(failed.base, (b) => b, {
      guard: stopped, capture(type, data) { if (type === "runner.provider_bridge_error") errors.push(data); },
    });
    try {
      await post(broken.baseUrl).then((reply) => reply.text()).catch(() => undefined);
      assert.equal((await post(broken.baseUrl, { model: "fixture", input: "no replay" })).status, 400);
      assert.equal(stopped.accounting.physicalRequests, 1);
      assert.equal(stopped.accounting.ambiguousRequests, 1);
      assert.equal(errors[0].phase, "upstream-body");
      assert.equal(errors[0].upstreamStatus, 200);
      assert.ok(Number(errors[0].responseBytes) > 0);
      assert.doesNotMatch(JSON.stringify(errors), /public fixture|authorization/);
    } finally { await broken.stop(); await failed.close(); }
});

test("downstream disconnection cancels the in-flight upstream and never permits replay", async () => {
    let dispatched!: () => void;
    const started = new Promise<void>((resolve) => { dispatched = resolve; });
    const host = await upstream((_req, res) => { dispatched(); res.writeHead(200, { "content-type": "text/event-stream" }); res.write(": fixture\n\n"); });
    const guard = new RequestGuard(), proxy = await startRequestSanitizingProxy(host.base, (b) => b, { guard });
    try {
      const req = request(`${proxy.baseUrl}/responses`, { method: "POST", headers: { "content-type": "application/json" } });
      req.on("error", () => undefined); req.end('{"input":"fixture"}');
      await started; req.destroy();
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal((await post(proxy.baseUrl)).status, 400);
      assert.equal(guard.accounting.physicalRequests, 1);
      assert.equal(guard.accounting.ambiguousRequests, 1);
    } finally { await proxy.stop(); await host.close(); }
});

test("upstream pre-header reset and deadline retain distinct safe causes without redispatch", async () => {
  for (const mode of ["reset", "deadline"] as const) {
    const host = await upstream((req) => { if (mode === "reset") req.socket.destroy(); });
    const events: Array<Record<string, unknown>> = [];
    const guard = new RequestGuard(undefined, Date.now(), Date.now() + 200);
    const proxy = await startRequestSanitizingProxy(host.base, (b) => b, { guard,
      capture(type, data) { if (type === "runner.provider_bridge_error") events.push(data); },
    });
    try {
      await (await post(proxy.baseUrl)).text();
      assert.equal((await post(proxy.baseUrl, { input: "another request" })).status, 400);
      assert.equal(guard.accounting.physicalRequests, 1);
      assert.equal(guard.accounting.ambiguousRequests, 1);
      assert.equal(events[0].phase, "upstream-headers");
      assert.equal(events[0].upstreamStatus, null);
      assert.equal(events[0].responseBytes, 0);
      if (mode === "deadline") assert.match(String(events[0].reason), /deadline exceeded/);
      else assert.equal(events[0].code, "ECONNRESET");
    } finally { await proxy.stop(); await host.close(); }
  }
});

test("terminal Responses failure categories and usage survive streaming/JSON failures without replay or private payloads", async () => {
  const usage = { input_tokens: 100, output_tokens: 32, total_tokens: 132,
    input_tokens_details: { cached_tokens: 40, cache_write_tokens: 10 }, output_tokens_details: { reasoning_tokens: 30 } };
  const cases = [
    { type: "response.incomplete", response: { id: "fixture", status: "incomplete", output: [], incomplete_details: { reason: "max_output_tokens" }, max_output_tokens: 32, usage } },
    { type: "response.incomplete", response: { id: "fixture", status: "incomplete", output: [], incomplete_details: { reason: "content_filter" }, usage } },
    { type: "response.failed", response: { id: "fixture", status: "failed", output: [], error: { code: "server_error", message: "PRIVATE_PROVIDER_TEXT" }, usage } },
    { type: "error", code: "context_length_exceeded", message: "PRIVATE_PROVIDER_TEXT" },
    { type: "error", code: "rate_limit_exceeded", message: "PRIVATE_PROVIDER_TEXT" },
    { type: "response.failed", response: { id: "fixture", status: "failed", output: [], error: { code: "rate_limit_exceeded", message: "PRIVATE_PROVIDER_TEXT" }, usage } },
  ];
  for (const streaming of [true, false]) for (const fixture of cases) {
    let calls = 0;
    const data = streaming ? `event: ${fixture.type}\ndata: ${JSON.stringify(fixture)}\n\n`
      : JSON.stringify("response" in fixture ? fixture.response : { error: { code: fixture.code, message: fixture.message } });
    const host = await upstream((req, res) => {
      calls++;
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        assert.equal(JSON.parse(Buffer.concat(chunks).toString()).max_output_tokens, 32);
        res.writeHead(200, { "content-type": streaming ? "text/event-stream" : "application/json" }); res.end(data);
      });
    });
    const guard = new RequestGuard({ maxRequests: 2, maxRequestBytes: 10000, maxTokens: 10000, maxOutputTokens: 32,
      deadlineMs: 5000, requestsPerMinute: 10, tokensPerMinute: 10000 });
    const captured: Array<{ type: string; data: import("../src/types.js").JsonRecord }> = [];
    const proxy = await startRequestSanitizingProxy(host.base, (body) => body, {
      guard, wireApi: "responses", retries: 2, capture(type, data) { captured.push({ type, data }); },
    });
    try {
      await post(proxy.baseUrl).then((response) => response.text()).catch(() => undefined);
      const first = captured.find((entry) => entry.type === "runner.provider_bridge_error")!.data;
      assert.equal(first.phase, "provider-terminal");
      assert.equal(first.upstreamStatus, 200); assert.equal(first.responseBytes, Buffer.byteLength(data));
      assert.equal(first.certainty, "possibly-processed"); assert.equal(first.outputTokenLimit, 32);
      const terminal = guard.accounting.providerTerminals?.[0].terminal;
      assert.ok(terminal);
      assert.equal(terminal.eventType, fixture.type === "error" && !streaming ? "provider.error" : fixture.type);
      assert.deepEqual(first.providerTerminal, terminal);
      assert.equal(terminal.responseStatus, "response" in fixture ? fixture.response.status : null);
      assert.equal(terminal.usageStatus, fixture.type === "error" ? "missing" : "reported");
      assert.equal(terminal.usage?.reasoningTokens ?? null, fixture.type === "error" ? null : 30);
      assert.equal(terminal.usage?.outputTokens ?? null, fixture.type === "error" ? null : 32);
      if (terminal.incompleteReason === "max_output_tokens") assert.match(String(first.reason), /includes reasoning and visible output/);
      const normalized = captured.map((entry, index) => ({ ...event(index + 1, entry.type, "2026-10-12T00:00:00Z"), data: entry.data }));
      const metrics = deriveMetrics(normalized, []);
      assert.equal(metrics.inputTokens.value, fixture.type === "error" ? null : 100);
      assert.equal(metrics.outputTokens.value, fixture.type === "error" ? null : 32);
      assert.equal(metrics.cost.value, null);
      assert.equal(guard.cleanlySettled(), false);
      assert.equal((await post(proxy.baseUrl, { model: "fixture", input: "not a retry" })).status, 400);
      assert.equal(calls, 1); assert.equal(guard.accounting.physicalRequests, 1);
      assert.equal(guard.accounting.ambiguousRequests, 1); assert.equal(guard.accounting.rejectedRequests, 0);
      assert.doesNotMatch(JSON.stringify(captured), /PRIVATE_PROVIDER_TEXT|authorization|accessToken/);
    } finally { await proxy.stop(); await host.close(); }
  }
});

test("post-200 rate-limit error retains prior meters and unknown failed usage without rejected-429 replay", async () => {
  let calls = 0;
  const host = await upstream((_req, res) => {
    calls++;
    const terminal = calls <= 3 ? { type: "response.completed", response: { status: "completed", output: [],
      usage: { input_tokens: 100, output_tokens: 32, total_tokens: 132, output_tokens_details: { reasoning_tokens: 30 } } } }
      : { type: "error", code: "rate_limit_exceeded", message: "PRIVATE_THROTTLE_TEXT" };
    res.writeHead(200, { "content-type": "text/event-stream", "retry-after-ms": "1" });
    res.end(`data: ${JSON.stringify(terminal)}\n\n`);
  });
  const guard = new RequestGuard();
  const captured: Array<{ type: string; data: import("../src/types.js").JsonRecord }> = [];
  const proxy = await startRequestSanitizingProxy(host.base, (body) => body, {
    guard, retries: 3, capture(type, data) { captured.push({ type, data }); },
  });
  try {
    for (let i = 0; i < 3; i++) await (await post(proxy.baseUrl, { model: "fixture", input: `Public round ${i}` })).text();
    await post(proxy.baseUrl, { model: "fixture", input: "Public fourth round" }).then((response) => response.text()).catch(() => undefined);
    const first = captured.find((entry) => entry.type === "runner.provider_bridge_error")!.data;
    const normalized = captured.map((entry, index) => ({ ...event(index + 1, entry.type, "2026-10-13T00:00:00Z"), data: entry.data }));
    const diagnostics = createRunDiagnostics(normalized, fixtureRuntime, [], "later synthetic HTTP 400");
    assert.equal(diagnostics.providerFailure.signature, "provider_rate_limit");
    assert.equal(diagnostics.providerFailure.httpStatus, 200);
    assert.equal(first.phase, "provider-terminal"); assert.equal(first.certainty, "possibly-processed");
    assert.match(diagnostics.providerFailure.message!, /RPM\/TPM.*cooldown.*unknown/);
    assert.equal(canRetryRequest("possibly-processed", 429), false);
    assert.equal(canRetryRequest("possibly-processed", 200), false);
    const terminal = guard.accounting.providerTerminals?.[3].terminal;
    assert.equal(terminal?.errorCode, "rate_limit_exceeded");
    assert.equal(terminal?.terminalResponse, false);
    assert.equal(terminal?.usageStatus, "missing"); assert.equal(terminal?.usage, null);
    const metrics = deriveMetrics(normalized, []);
    assert.equal(metrics.inputTokens.value, 300); assert.equal(metrics.outputTokens.value, 96);
    assert.equal(metrics.inputTokens.value! + metrics.outputTokens.value!, 396); assert.equal(metrics.cost.value, null);
    assert.equal(guard.cleanlySettled(), false);
    assert.equal((await post(proxy.baseUrl, { model: "fixture", input: "Not a replay" })).status, 400);
    assert.equal(calls, 4); assert.equal(guard.accounting.physicalRequests, 4);
    assert.equal(guard.accounting.ambiguousRequests, 1); assert.equal(guard.accounting.rejectedRequests, 0);
    assert.doesNotMatch(JSON.stringify(captured), /PRIVATE_THROTTLE_TEXT|authorization|accessToken/);
  } finally { await proxy.stop(); await host.close(); }
});

test("provider terminal metadata maps unknown categories safely and never infers missing/malformed usage or doubles reasoning", () => {
  const terminal = providerTerminal({ type: "response.incomplete", response: { status: "incomplete", output: [],
    incomplete_details: { reason: "PRIVATE_REASON" }, error: { code: "SECRET_TOKEN", message: "PRIVATE_PROVIDER_TEXT" },
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, output_tokens_details: { reasoning_tokens: 4 } } } }, true)!;
  assert.equal(terminal.incompleteReason, "other"); assert.equal(terminal.errorCode, "other");
  assert.equal(terminal.usage?.outputTokens, 5); assert.equal(terminal.usage?.reasoningTokens, 4);
  assert.doesNotMatch(JSON.stringify(terminal), /PRIVATE|SECRET/);
  for (const usage of [null, "PRIVATE_USAGE", { input_tokens: -1, output_tokens: 5 }, { input_tokens: 10, output_tokens: 5, total_tokens: 99 },
    { input_tokens: 10, output_tokens: 5, output_tokens_details: { reasoning_tokens: 6 } }]) {
    const evidence = providerTerminal({ type: "response.failed", response: { status: "failed", output: [], usage } }, true)!;
    assert.equal(evidence.usage, null);
    assert.equal(evidence.usageStatus, usage === null ? "missing" : "invalid");
  }
  const partial = providerTerminal({ type: "response.failed", response: { status: "failed", output: [], usage: { output_tokens: 5 } } }, true)!;
  assert.equal(partial.usageStatus, "partial"); assert.equal(partial.usage?.inputTokens, null);
  const unframed = new ProviderStream("/responses");
  assert.throws(() => { unframed.push(Buffer.from('data: {"type":"response.incomplete","response":{"status":"incomplete"}}\n')); unframed.finish(); }, /inside an SSE event/);
  const malformed = new ProviderStream("/responses");
  assert.throws(() => malformed.push(Buffer.from('data: {"type":"response.incomplete"}\n\n')),
    (error: unknown) => error instanceof ProviderTerminalError && !error.terminal.terminalResponse && !/allowance exhausted/i.test(error.message));
  const headerOnly = new ProviderStream("/responses");
  assert.throws(() => headerOnly.push(Buffer.from('event: error\ndata: {"code":"server_error","message":"PRIVATE_TEXT"}\n\n')),
    (error: unknown) => error instanceof ProviderTerminalError && error.terminal.errorCode === "server_error" && !/PRIVATE_TEXT/.test(error.message));
  const contradictory = new ProviderStream("/responses");
  assert.throws(() => contradictory.push(Buffer.from('event: response.incomplete\ndata: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n')), /types disagree/);
  const invalidSuccess = new ProviderStream("/responses");
  assert.throws(() => invalidSuccess.push(Buffer.from('data: {"type":"response.completed","response":{"status":"completed","output":[],"error":{"code":"server_error"}}}\n\n')),
    (error: unknown) => error instanceof ProviderTerminalError && !error.terminal.terminalResponse);
});

test("valid JSON Responses completion accepts nullable error and retains provider usage", async () => {
  const host = await upstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "fixture", status: "completed", error: null, output: [],
      usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 } }));
  });
  const guard = new RequestGuard(), proxy = await startRequestSanitizingProxy(host.base, (body) => body, { guard, wireApi: "responses" });
  try {
    assert.equal((await post(proxy.baseUrl)).status, 200); assert.equal(guard.cleanlySettled(), true);
    assert.equal(guard.accounting.providerTerminals?.[0].terminal.usage?.totalTokens, 105);
  } finally { await proxy.stop(); await host.close(); }
});
