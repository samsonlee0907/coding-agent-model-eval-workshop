import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { RequestGuard, DeploymentAdmission, DispatchError, canRetryRequest, retryDelay } from "../src/request-policy.js";
import { startRequestSanitizingProxy, dispatchBenchmarkWorkRequests, benchmarkWorkRequests } from "../src/runner.js";

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
  assert.equal(new RequestGuard(undefined, 0, 3600000).deadline, 3600000);
  const guard = new RequestGuard({ maxRequests: 1, maxRequestBytes: 1000, maxTokens: 1000, maxOutputTokens: 50, deadlineMs: 5000, requestsPerMinute: 2, tokensPerMinute: 1000 });
  guard.reserve(300, 150); guard.ambiguous();
  assert.deepEqual(guard.accounting, { physicalRequests: 1, reservedTokens: 150, ambiguousRequests: 1, rejectedRequests: 0 });
  assert.throws(() => guard.reserve(1, 1), /closed/);
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
      const response = await post(proxy.baseUrl); await response.text();
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
        await (await post(proxy.baseUrl)).text();
        assert.equal((await post(proxy.baseUrl, { model: "fixture", input: "different request" })).status, 400);
        assert.equal(calls, 1); assert.equal(guard.accounting.ambiguousRequests, 1);
      } finally { await proxy.stop(); await host.close(); }
    }
  });
test("large valid terminal SSE events are not silently truncated at 8 KiB", async () => {
    const host = await upstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const text = `data: ${JSON.stringify({ type: "response.completed", response: { output: "x".repeat(100000) } })}\n\n`;
      res.write(text.slice(0, 50000)); setTimeout(() => res.end(text.slice(50000)), 1);
    });
    const guard = new RequestGuard(), proxy = await startRequestSanitizingProxy(host.base, (b) => b, { guard });
    try { await (await post(proxy.baseUrl)).text(); assert.equal(guard.accounting.ambiguousRequests, 0); }
    finally { await proxy.stop(); await host.close(); }
  });
