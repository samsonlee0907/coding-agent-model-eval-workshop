import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createServer, request } from "node:http";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import https from "node:https";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { CopilotClient, RuntimeConnection, ToolSet, defineTool, approveAll } from "@github/copilot-sdk";
import { countNativeTokens, nativeCountBody, applyAnthropicThinking, canRetryNativeCount,
  nativeTokenCountAccountingSchema, type NativeTokenCountAccounting, type NativeTokenCountPolicy } from "../src/native-token-count.js";
import { RequestGuard, DeploymentAdmission, type PolicyClock } from "../src/request-policy.js";
import { startRequestSanitizingProxy, stripTemperature, createRunDiagnostics, createFoundryProviderIdentity, resolveCopilotCliPath, runBenchmark } from "../src/runner.js";
import { readRuntimeIdentity } from "../src/runtime-identity.js";
import { scrubFoundryEnvironment } from "../src/validation.js";
import { extractModelCalls } from "../src/metrics.js";
import { selectedResultRows } from "../src/publication.js";
import { evidenceFromRuns } from "../src/evidence.js";
import { renderEvidenceReport } from "../src/report-ui.js";
import { renderRunReport } from "../src/report.js";
import { providerSchema, bearerTokenProvider } from "../src/auth.js";
import { benchmarkConfigSchema } from "../src/config-schema.js";
import { compareRunContracts, comparableBaselineSignature } from "../src/contract.js";
import { parseQuickstartOptions } from "../src/quickstart.js";
import { attemptFromRun, assertBenchmarkRun } from "../src/evidence.js";
import { estimateRunPriceUsd } from "../src/pricing.js";
import { fixtureConfig, fixtureRun, fixtureRuntime } from "./fixtures/revamp.js";
import { event } from "./fixtures/events.js";

const policy: NativeTokenCountPolicy = {
  schemaVersion: 1, maxAttempts: 3, maxRequests: 20, requestTimeoutMs: 500,
  baseDelayMs: 1, maxDelayMs: 20, jitter: 0, maxRetryWaitMs: 100,
  inputSafetyMarginPercent: 5, inputSafetyMarginTokens: 64,
};
const model = "fixture-deployment";
const message = (text = "Safe fixture") => ({ model, messages: [{ role: "user", content: text }], max_tokens: 100 });
const accounting = (): NativeTokenCountAccounting => ({
  schemaVersion: 1, requests: 0, retries: 0, completed: 0, retryWaitMs: 0, fees: "unknown", attempts: [],
});
function reply(status: number, body: string, headers: Record<string, string> = {}) {
  return { status, headers: new Headers(headers), body: (async function* () { yield Buffer.from(body); })(), cancel() {} };
}
function fakeClock(start = 0) {
  let now = start;
  const sleeps: number[] = [];
  const clock: PolicyClock = { now: () => now, async sleep(ms, signal) { signal?.throwIfAborted(); sleeps.push(ms); now += ms; } };
  return { clock, sleeps, advance: (ms: number) => { now += ms; } };
}

test("native count floors fractional deadlines and rejects invalid or sub-millisecond clocks before dispatch", async () => {
  const counters = accounting(), time = fakeClock(0.25);
  const result = await countNativeTokens(Buffer.from(JSON.stringify(message())), {
    policy, accounting: counters, clock: time.clock, deadline: 100.75,
    signal: new AbortController().signal, model, beforeDispatch: async () => {},
    async send() { return reply(200, '{"input_tokens":123}'); },
  });
  assert.equal(result, 123); assert.equal(counters.requests, 1);
  for (const [now, deadline] of [[0.25, 0.75], [NaN, 100], [0, NaN], [Infinity, 100], [0, Infinity]]) {
    const rejected = accounting();
    let admissions = 0, sends = 0;
    await assert.rejects(countNativeTokens(Buffer.from(JSON.stringify(message())), {
      policy, accounting: rejected, clock: fakeClock(now).clock, deadline,
      signal: new AbortController().signal, model, beforeDispatch: async () => { admissions++; },
      async send() { sends++; return reply(200, '{"input_tokens":123}'); },
    }), /deadline/);
    assert.equal(admissions, 0); assert.equal(sends, 0);
    assert.equal(rejected.requests, 0); assert.equal(rejected.retries, 0); assert.equal(rejected.fees, "unknown");
  }
});

test("native count retries the identical Azure Timeout/408 without a model request and preserves safe IDs", async () => {
  const counters = accounting(), time = fakeClock(), bodies: string[] = [];
  let admissions = 0;
  const result = await countNativeTokens(Buffer.from(JSON.stringify(message())), {
    policy, accounting: counters, clock: time.clock, random: () => 0.5, deadline: 10000,
    signal: new AbortController().signal, model, beforeDispatch: async () => { admissions++; },
    async send(body) {
      bodies.push(body.toString());
      return bodies.length === 1 ? reply(408, '{"error":{"code":"Timeout","message":"Bearer private-token https://private.invalid"}}',
        { "apim-request-id": "11111111-2222-4333-8444-555555555555", "retry-after-ms": "10" })
        : reply(200, '{"input_tokens":123}');
    },
  });
  assert.equal(result, 123);
  assert.equal(admissions, 2);
  assert.equal(bodies[0], bodies[1]);
  assert.ok(!bodies[0].includes("max_tokens"));
  assert.deepEqual(time.sleeps, [10]);
  assert.equal(counters.requests, 2); assert.equal(counters.retries, 1); assert.equal(counters.completed, 1);
  assert.equal(counters.retryWaitMs, 10); assert.equal(counters.fees, "unknown");
  assert.equal(counters.attempts[0].code, "Timeout");
  assert.equal(counters.attempts[0].requestIds["apim-request-id"], "11111111-2222-4333-8444-555555555555");
  assert.doesNotMatch(JSON.stringify(counters), /private-token|private\.invalid|message/);
  nativeTokenCountAccountingSchema.parse(counters);
});

test("native recovery honors Retry-After minimum/date, finite wait limits and bounded jitter", async () => {
  for (const [headers, delay] of [[{ "retry-after": "1" }, 1000], [{ "retry-after": "Thu, 01 Jan 1970 00:00:02 GMT" }, 2000], [{}, 7.5]] as const) {
    const time = fakeClock(), counters = accounting();
    const result = await countNativeTokens(Buffer.from(JSON.stringify(message())), {
      policy: { ...policy, baseDelayMs: 10, jitter: 0.5, maxRetryWaitMs: 3000 },
      accounting: counters, clock: time.clock, random: () => 0.5, deadline: 4000,
      signal: new AbortController().signal, model, beforeDispatch: async () => {},
      async send() { return counters.requests === 1 ? reply(503, '{"error":{"code":"unavailable"}}', headers) : reply(200, '{"input_tokens":0}'); },
    });
    assert.equal(result, 0); assert.deepEqual(time.sleeps, [delay]);
  }
  const time = fakeClock(), counters = accounting();
  await assert.rejects(countNativeTokens(Buffer.from(JSON.stringify(message())), {
    policy, accounting: counters, clock: time.clock, deadline: 10000, signal: new AbortController().signal, model,
    beforeDispatch: async () => {}, send: async () => reply(408, '{"error":{"code":"Timeout"}}', { "retry-after": "1" }),
  }), /retry_wait_limit/);
  assert.equal(counters.requests, 1); assert.deepEqual(time.sleeps, []);
});

test("count status/category classification never retries auth, permanent/unknown quota, malformed or non-200 success", async () => {
  assert.equal(canRetryNativeCount(408, "Timeout"), true);
  assert.equal(canRetryNativeCount(429, "rate_limit_error"), true);
  for (const code of [null, "other", "insufficient_quota", "quota_exceeded"]) assert.equal(canRetryNativeCount(429, code), false);
  assert.equal(canRetryNativeCount(null, "ECONNRESET"), true);
  assert.equal(canRetryNativeCount(null, "ENOTFOUND"), false);
  for (const [status, body] of [
    [400, '{"error":{"type":"invalid_request_error"}}'], [401, '{"error":{"code":"expired_token"}}'],
    [403, '{"error":{"code":"denied"}}'], [404, '{"error":{"code":"missing_model"}}'],
    [429, '{"error":{"code":"insufficient_quota"}}'], [429, '{"error":null}'],
    [429, '{"error":{"code":{"type":"rate_limit"}}}'], [201, '{"input_tokens":10}'],
    [408, '{"error":{"code":"unknown"}}'], [408, '{"error":{"code":null,"type":"Timeout"}}'],
    [503, '{"error":{"code":"api_error","type":"invalid_request_error"}}'],
    [429, '{"error":{"code":"rate_limit","type":"insufficient_quota"}}'],
    [200, '{}'], [200, '{"input_tokens":"10"}'], [200, '{"input_tokens":-1}'],
    [200, '{"input_tokens":10,"unexpected":true}'], [200, 'invalid-json'],
  ] as const) {
    const counters = accounting(), time = fakeClock();
    await assert.rejects(countNativeTokens(Buffer.from(JSON.stringify(message())), {
      policy, accounting: counters, clock: time.clock, deadline: 10000,
      signal: new AbortController().signal, model, beforeDispatch: async () => {}, send: async () => reply(status, body),
    }));
    assert.equal(counters.requests, 1); assert.equal(counters.retries, 0); assert.equal(counters.completed, 0);
    assert.deepEqual(time.sleeps, []);
  }
});

test("native count attempt/global bounds, expired deadline, cancellation and mid-body deadlines never bypass admission", async () => {
  const time = fakeClock(), counters = accounting();
  await assert.rejects(countNativeTokens(Buffer.from(JSON.stringify(message())), {
    policy: { ...policy, maxRequests: 2 }, accounting: counters, clock: time.clock, deadline: 10000,
    signal: new AbortController().signal, model, beforeDispatch: async () => {},
    send: async () => reply(408, '{"error":{"code":"Timeout"}}'),
  }), /request_limit/);
  assert.equal(counters.requests, 2);
  for (const mode of ["expired", "cancelled", "late", "retry-deadline", "cancel-wait"] as const) {
    const controller = new AbortController(), clock = fakeClock(), counter = accounting();
    if (mode === "cancelled") controller.abort();
    await assert.rejects(countNativeTokens(Buffer.from(JSON.stringify(message())), {
      policy, accounting: counter, clock: {
        now: clock.clock.now, async sleep(ms) { controller.abort(); controller.signal.throwIfAborted(); },
      },
      deadline: mode === "expired" ? 0 : 5, signal: controller.signal, model, beforeDispatch: async () => {},
      async send() {
        if (mode === "late") { clock.advance(5); return reply(200, '{"input_tokens":10}'); }
        return reply(408, '{"error":{"code":"Timeout"}}', mode === "retry-deadline" ? { "retry-after-ms": "10" } : {});
      },
    }), /deadline|cancelled/);
    assert.equal(counter.requests, ["expired", "cancelled"].includes(mode) ? 0 : 1);
    assert.equal(counter.completed, 0);
  }
});

test("count body/explicit adaptive wire policy preserves inputs and has no model-name heuristics", () => {
  const original = { ...message(), thinking: { type: "enabled", budget_tokens: 4096 }, output_config: { format: { type: "json_schema" } }, stream: true, temperature: 0.1 };
  const transformed = JSON.parse(applyAnthropicThinking(Buffer.from(JSON.stringify(original)), "high").toString());
  assert.deepEqual(transformed.thinking, { type: "adaptive" });
  assert.equal(transformed.output_config.effort, "high");
  assert.deepEqual(transformed.messages, original.messages);
  const count = JSON.parse(nativeCountBody(Buffer.from(JSON.stringify(transformed)), model).toString());
  assert.deepEqual(count.thinking, transformed.thinking);
  assert.deepEqual(count.output_config, transformed.output_config);
  assert.equal(count.temperature, undefined); assert.equal(count.stream, undefined); assert.equal(count.max_tokens, undefined);
  assert.throws(() => nativeCountBody(Buffer.from(JSON.stringify({ ...message(), model: "wrong" })), model), /invalid_messages_profile/);
  assert.throws(() => nativeCountBody(Buffer.from(JSON.stringify({ ...message(), unknown: true })), model), /unsupported_count_source_field/);
  assert.throws(() => providerSchema.parse({ type: "openai", nativeTokenCount: policy }));
  const config = fixtureConfig(); config.contract.candidate.provider = "anthropic";
  config.contract.foundryProvider = { type: "anthropic", nativeTokenCount: policy, anthropicThinking: "adaptive" };
  assert.throws(() => benchmarkConfigSchema.parse(config), /finite requestBounds/);
  const options = parseQuickstartOptions(["--task", "test", "--provider", "anthropic", "--model", model,
    "--native-token-count", "examples\\native-token-count.example.json", "--anthropic-thinking", "adaptive",
    "--bounds", "examples\\request-bounds.example.json", "--prepare-only"]);
  assert.equal(options.nativeTokenCount?.maxAttempts, 4); assert.equal(options.anthropicThinking, "adaptive");
  const identity = createFoundryProviderIdentity(config.contract.foundryProvider, { FOUNDRY_ENDPOINT: "https://fixture.services.ai.azure.com" });
  assert.deepEqual(identity.nativeTokenCount, policy); assert.equal(identity.anthropicThinking, "adaptive");
  const first = fixtureRun("fixture", config), second = structuredClone(first);
  first.contract.foundryProvider = identity;
  second.contract.foundryProvider = { ...identity, nativeTokenCount: { ...policy, maxAttempts: 1 } };
  assert.ok(compareRunContracts(first.contract, second.contract).drift.some(d => d.path.includes("nativeTokenCount")));
  assert.notEqual(comparableBaselineSignature(first.contract), comparableBaselineSignature(second.contract));
});

async function host(handler: Parameters<typeof createServer>[0]) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  return { base: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }) };
}
const post = (base: string, text = "Safe fixture") => fetch(`${base}/v1/messages`, {
  method: "POST", headers: { "content-type": "application/json", authorization: "Bearer FIXTURE_ONLY" }, body: JSON.stringify(message(text)),
});
function guard() { return new RequestGuard({
  maxRequests: 10, maxRequestBytes: 10000, maxTokens: 10000, maxOutputTokens: 100,
  deadlineMs: 5000, requestsPerMinute: 100, tokensPerMinute: 10000,
}); }

test("actual bridge recovers count408, forwards exactly one model call, and a hidden reissue cannot reset recovery", async () => {
  let counts = 0, models = 0; const countBodies: string[] = [];
  const upstream = await host((req, res) => {
    let text = ""; req.on("data", chunk => text += chunk); req.on("end", () => {
      if (req.url === "/v1/messages/count_tokens") {
        counts++; countBodies.push(text);
        res.writeHead(counts === 1 ? 408 : 200, { "content-type": "application/json", "apim-request-id": "safe-count-id" });
        res.end(counts === 1 ? '{"error":{"code":"Timeout","message":"The operation was timeout."}}' : '{"input_tokens":100}');
      } else {
        models++;
        assert.equal(JSON.parse(text).thinking.type, "adaptive"); assert.equal(JSON.parse(text).output_config.effort, "high");
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"id":"fixture","type":"message","stop_reason":"end_turn","content":[]}');
      }
    });
  });
  const g = guard(), proxy = await startRequestSanitizingProxy(upstream.base, stripTemperature, {
    guard: g, nativeTokenCount: policy, model, anthropicThinking: "adaptive", reasoningEffort: "high",
  });
  try {
    assert.equal((await post(proxy.baseUrl)).status, 200);
    assert.equal(counts, 2); assert.equal(models, 1);
    assert.equal(countBodies[0], countBodies[1]);
    assert.equal(g.accounting.physicalRequests, 1); assert.equal(g.accounting.reservedTokens, 269);
    assert.equal(g.accounting.ambiguousRequests, 0);
    assert.equal(g.cleanlySettled(), true);
    assert.equal(g.accounting.nativeTokenCount?.requests, 2); assert.equal(g.accounting.nativeTokenCount?.retries, 1);
    assert.equal((await post(proxy.baseUrl)).status, 400);
    assert.equal(counts, 2); assert.equal(models, 1);
    const run = fixtureRun("saved-count-fixture"); run.requestAccounting = g.accounting;
    assertBenchmarkRun(run);
    const evidence = attemptFromRun(run, "task", "model");
    assert.equal(evidence.accounting.nativeTokenCount?.requests, 2);
    assert.doesNotMatch(JSON.stringify(evidence.accounting), /safe-count-id|countBodyHash/);
    assert.match(estimateRunPriceUsd(run, null).unavailableReason!, /fees are unknown/);
    const reportEvidence = evidenceFromRuns([run]), rows = selectedResultRows(reportEvidence);
    assert.equal(rows[0].nativeCountRequests, 2); assert.equal(rows[0].nativeCountRetries, 1);
    assert.equal(rows[0].physicalInferenceRequests, 1); assert.equal(rows[0].allAttemptNativeCountRequests, 2);
    assert.equal(rows[0].nativeCountFees, "unknown");
    assert.match(renderRunReport(run), /Native count requests \/ retries \| 2 \/ 1/);
    assert.match(renderEvidenceReport(reportEvidence), /Count fees are unknown/);
  } finally { await proxy.stop(); await upstream.close(); }
});

test("exhausted count408 is a retained infra interruption, not inferred content FAIL or an inference dispatch", async () => {
  let calls = 0;
  const upstream = await host((_req, res) => { calls++; res.writeHead(408, { "content-type": "application/json", "apim-request-id": "count-id" }); res.end('{"error":{"code":"Timeout"}}'); });
  const g = guard(), events: Array<ReturnType<typeof event>> = [];
  const proxy = await startRequestSanitizingProxy(upstream.base, body => body, {
    guard: g, nativeTokenCount: policy, model, capture(type, data) {
      events.push({ ...event(events.length + 1, type, "2026-10-14T00:00:00Z"), data });
    },
  });
  try {
    const first = await post(proxy.baseUrl); assert.equal(first.status, 400); assert.match(await first.text(), /attempt_limit/);
    assert.equal(calls, 3); assert.equal(g.accounting.physicalRequests, 0);
    assert.equal(g.accounting.reservedTokens, 0); assert.equal(g.accounting.ambiguousRequests, 0);
    assert.equal((await post(proxy.baseUrl, "new SDK attempt")).status, 400); assert.equal(calls, 3);
    const diagnostic = createRunDiagnostics(events, fixtureRuntime, [], "native count failed");
    assert.equal(diagnostic.providerFailure.signature, "native_token_count_failure"); assert.equal(diagnostic.providerFailure.httpStatus, 408);
    const run = fixtureRun("interrupted-count", fixtureConfig(), "ungraded"); run.executionStatus = "interrupted"; run.requestAccounting = g.accounting;
    const result = attemptFromRun(run, "task", "model");
    assert.equal(result.acceptance, "ungraded");
    assert.equal(result.execution, "interrupted"); assert.equal(result.phase, "execution");
  } finally { await proxy.stop(); await upstream.close(); }
});

test("count per-attempt timeout recovers but whole-lane deadline and downstream cancellation never dispatch a model", async () => {
  for (const mode of ["timeout", "deadline", "disconnect"] as const) {
    let counts = 0, models = 0, started!: () => void;
    const dispatched = new Promise<void>(resolve => { started = resolve; });
    const upstream = await host((req, res) => {
      if (req.url?.endsWith("/count_tokens")) {
        counts++; started();
        if (mode === "timeout" && counts > 1) { res.writeHead(200); res.end('{"input_tokens":1}'); }
      } else { models++; res.writeHead(200); res.end('{"id":"fixture","type":"message","stop_reason":"end_turn","content":[]}'); }
    });
    const g = mode === "deadline" ? new RequestGuard(guard().bounds, Date.now(), Date.now() + 50) : guard();
    const proxy = await startRequestSanitizingProxy(upstream.base, body => body, { guard: g, nativeTokenCount: { ...policy, requestTimeoutMs: mode === "timeout" ? 15 : 500 }, model });
    try {
      if (mode === "disconnect") {
        const req = request(`${proxy.baseUrl}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" } });
        req.on("error", () => undefined); req.end(JSON.stringify(message()));
        await dispatched; req.destroy(); await new Promise(resolve => setTimeout(resolve, 30));
      } else {
        const result = await post(proxy.baseUrl); await result.text();
        assert.equal(result.status, mode === "timeout" ? 200 : 400);
      }
      assert.equal(models, mode === "timeout" ? 1 : 0);
      assert.equal(counts, mode === "timeout" ? 2 : 1);
      assert.equal(g.accounting.physicalRequests, models);
      assert.equal(g.accounting.ambiguousRequests, 0);
    } finally { await proxy.stop(); await upstream.close(); }
  }
});

test("native admission shares deployment RPM with inference and refuses unfit reservations with no bypass", async () => {
  const time = fakeClock(), admission = new DeploymentAdmission(time.clock);
  await admission.admit("deployment", 0, 1, 1000, 60001);
  await admission.admit("deployment", 200, 1, 1000, 60001);
  assert.deepEqual(time.sleeps, [60000]);
  const upstream = await host((req, res) => { assert.ok(req.url?.endsWith("count_tokens")); res.writeHead(200); res.end('{"input_tokens":10000}'); });
  const g = guard(), proxy = await startRequestSanitizingProxy(upstream.base, body => body, { guard: g, nativeTokenCount: policy, model });
  try {
    assert.equal((await post(proxy.baseUrl)).status, 400);
    assert.equal(g.accounting.nativeTokenCount?.completed, 1); assert.equal(g.accounting.physicalRequests, 0);
  } finally { await proxy.stop(); await upstream.close(); }
});

test("ambiguous inference408/503/non200-success/partial200 never replays even with successful native count and retries configured", async () => {
  for (const mode of ["408", "503", "201", "partial"] as const) {
    let models = 0, counts = 0;
    const upstream = await host((req, res) => {
      if (req.url?.endsWith("count_tokens")) { counts++; res.writeHead(200); res.end('{"input_tokens":10}'); }
      else {
        models++;
        if (mode === "partial") { res.writeHead(200, { "content-type": "text/event-stream" }); res.end('data: {"type":"message_start"}\n\n'); }
        else { res.writeHead(Number(mode)); res.end('{"error":{"code":"Timeout"}}'); }
      }
    });
    const g = guard(), proxy = await startRequestSanitizingProxy(upstream.base, body => body, { guard: g, nativeTokenCount: policy, model, retries: 3 });
    try {
      await post(proxy.baseUrl).then(r => r.text()).catch(() => undefined);
      assert.equal((await post(proxy.baseUrl, "SDK reissue")).status, 400);
      assert.equal(models, 1); assert.equal(counts, 1);
      assert.equal(g.accounting.physicalRequests, 1);
      assert.equal(g.accounting.ambiguousRequests, 1);
    } finally { await proxy.stop(); await upstream.close(); }
  }
});

test("shared retry wait ceiling includes native and inference recovery without repeat token counts", async () => {
  let counts = 0, models = 0;
  const upstream = await host((req, res) => {
    if (req.url?.endsWith("count_tokens")) {
      counts++; res.writeHead(counts === 1 ? 408 : 200, { "retry-after-ms": "10" });
      res.end(counts === 1 ? '{"error":{"code":"Timeout"}}' : '{"input_tokens":10}');
    } else { models++; res.writeHead(429, { "retry-after-ms": "10" }); res.end('{"error":{"code":"rate_limit"}}'); }
  });
  const g = guard(), proxy = await startRequestSanitizingProxy(upstream.base, body => body, {
    guard: g, nativeTokenCount: { ...policy, maxRetryWaitMs: 15 }, model, retries: 3,
  });
  try {
    const response = await post(proxy.baseUrl); assert.equal(response.status, 400);
    assert.match(await response.text(), /Shared native-count\/inference retry wait bound/);
    assert.equal(counts, 2); assert.equal(models, 1); assert.equal(g.accounting.retryWaitMs, 10);
    assert.equal(g.accounting.rejectedRequests, 1);
  } finally { await proxy.stop(); await upstream.close(); }
});

test("successful count is reused only inside a certified transient inference429 retry", async () => {
  let counts = 0, models = 0;
  const upstream = await host((req, res) => {
    if (req.url?.endsWith("count_tokens")) { counts++; res.writeHead(200); res.end('{"input_tokens":10}'); }
    else {
      models++; res.writeHead(models === 1 ? 429 : 200, { "retry-after-ms": "1" });
      res.end(models === 1 ? '{"error":{"code":"rate_limit"}}' : '{"id":"fixture","type":"message","stop_reason":"end_turn","content":[]}');
    }
  });
  const g = guard(), proxy = await startRequestSanitizingProxy(upstream.base, body => body, { guard: g, nativeTokenCount: policy, model, retries: 1 });
  try {
    assert.equal((await post(proxy.baseUrl)).status, 200);
    assert.equal(counts, 1); assert.equal(models, 2);
    assert.equal(g.accounting.physicalRequests, 2); assert.equal(g.accounting.rejectedRequests, 1);
    assert.equal(g.accounting.nativeTokenCount?.requests, 1);
  } finally { await proxy.stop(); await upstream.close(); }
});

test("unknown/null/object/contradictory inference429 categories cannot launder recovery authority", async () => {
  for (const error of [null, { code: "other" }, { code: { type: "rate_limit" } },
    { code: null, type: "rate_limit" }, { code: "rate_limit", type: "insufficient_quota" }]) {
    let models = 0;
    const upstream = await host((req, res) => {
      if (req.url?.endsWith("count_tokens")) { res.writeHead(200); res.end('{"input_tokens":10}'); }
      else { models++; res.writeHead(429, { "retry-after-ms": "1" }); res.end(JSON.stringify({ error })); }
    });
    const g = guard(), proxy = await startRequestSanitizingProxy(upstream.base, body => body, { guard: g, nativeTokenCount: policy, model, retries: 3 });
    try {
      const response = await post(proxy.baseUrl); await response.text();
      assert.equal(response.status, 400); assert.equal(models, 1);
      assert.equal(g.accounting.physicalRequests, 1); assert.equal(g.accounting.rejectedRequests, 1);
      assert.equal((await post(proxy.baseUrl, "hidden SDK replay")).status, 400); assert.equal(models, 1);
    } finally { await proxy.stop(); await upstream.close(); }
  }
});

test("actual public runBenchmark preserves fractional PolicyClock and spawned runtime without inference or incomplete grading after native rejection", { timeout: 60000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "bt-native-run-"));
  const prior = { endpoint: process.env.FOUNDRY_ENDPOINT, key: process.env.FOUNDRY_API_KEY };
  let counts = 0;
  const upstream = await host((req, res) => {
    assert.equal(req.url, "/anthropic/v1/messages/count_tokens");
    counts++;
    req.resume(); res.writeHead(408, { "content-type": "application/json", "apim-request-id": "public-run-fixture" });
    res.end('{"error":{"code":"Timeout","message":"The operation was timeout."}}');
  });
  const intercepted = mock.method(https, "request", (url: URL, options: Record<string, unknown>, callback: Parameters<typeof request>[2]) => {
    assert.equal(url.hostname, "fixture.services.ai.azure.com");
    return request(new URL(url.pathname, upstream.base), options, callback);
  });
  const spawned = mock.method(childProcess, "spawn");
  syncBuiltinESMExports();
  try {
    process.env.FOUNDRY_ENDPOINT = "https://fixture.services.ai.azure.com";
    process.env.FOUNDRY_API_KEY = "fixture-only-key";
    const config = fixtureConfig(root, "public-count-failure", "claude-haiku-5-5");
    config.contract.runtime = readRuntimeIdentity();
    config.contract.candidate.provider = "anthropic";
    config.contract.foundryProvider = { type: "anthropic", nativeTokenCount: { ...policy, requestTimeoutMs: 120000 }, anthropicThinking: "adaptive" };
    config.contract.task.validationCommand = 'node -e "require(\'node:fs\').writeFileSync(\'validator-started\',\'unexpected\')"';
    config.contract.task.conformanceProbe = { checks: [{ id: "public-check", description: "Must not grade interrupted execution.",
      severity: "required", command: 'node -e "require(\'node:fs\').writeFileSync(\'grader-started\',\'unexpected\')"' }] };
    config.requestBounds = { ...guard().bounds!, deadlineMs: 45000, maxRequestBytes: 1048576, maxTokens: 1000000, maxOutputTokens: 8192, tokensPerMinute: 1000000 };
    config.artifactsDirectory = join(root, "artifacts");
    const wall = Date.now(), monotonic = performance.now();
    const clock: PolicyClock = { now: () => Math.floor(wall + performance.now() - monotonic) + 0.406005859375,
      async sleep(ms, signal) { signal?.throwIfAborted(); await new Promise(resolve => setTimeout(resolve, ms)); } };
    const deadlineAt = clock.now() + 45000, admission = new DeploymentAdmission(clock);
    assert.equal(Number.isInteger(deadlineAt), false);
    const run = await runBenchmark(config, { runId: "owned-public-fixture", deadlineAt, admission });
    const cliPath = resolveCopilotCliPath(process.env);
    const cliSpawns = spawned.mock.calls.filter(call => Array.isArray(call.arguments[1])
      && call.arguments[1].includes("--headless") && call.arguments[1].includes("--stdio"));
    assert.equal(cliSpawns.length, 1);
    if (cliPath) {
      assert.ok(cliSpawns[0].arguments[0] === cliPath || cliSpawns[0].arguments[1].includes(cliPath));
      assert.equal(createHash("sha256").update(readFileSync(cliPath)).digest("hex"), config.contract.runtime.cliSha256);
    }
    assert.equal(run.diagnostics.runtime.cliVersion, config.contract.runtime.cliVersion);
    assert.equal(typeof run.diagnostics.reportedBackendVersion, "string");
    t.diagnostic(JSON.stringify({ selectedCliPath: cliPath ?? null,
      selection: cliPath ? "explicit-external" : "sdk-default-no-external-found", cliSha256: config.contract.runtime.cliSha256,
      cliVersion: config.contract.runtime.cliVersion, reportedBackendVersion: run.diagnostics.reportedBackendVersion,
      fractionalDeadline: deadlineAt, nativeFixtureRequests: counts, inferenceRequests: run.requestAccounting?.physicalRequests }));
    assert.equal(counts, 3); assert.equal(run.executionStatus, "interrupted"); assert.equal(run.outcome.class, "harness_failure");
    assert.equal(run.requestAccounting?.physicalRequests, 0); assert.equal(run.requestAccounting?.ambiguousRequests, 0);
    assert.equal(run.requestAccounting?.nativeTokenCount?.requests, 3);
    assert.equal(run.diagnostics.providerFailure.signature, "native_token_count_failure");
    assert.equal(run.diagnostics.providerFailure.httpStatus, 408);
    assert.equal(run.validation, null); assert.equal(run.conformance, undefined);
    assert.equal(attemptFromRun(run, "task", "candidate").acceptance, "ungraded");
    assert.equal(existsSync(join(root, "validator-started")), false);
    assert.equal(existsSync(join(root, "grader-started")), false);
    assert.deepEqual(JSON.parse(readFileSync(join(run.artifacts.directory, "run.json"), "utf8")).requestAccounting, run.requestAccounting);
    const checkpoint = JSON.parse(readFileSync(join(run.artifacts.directory, "execution.json"), "utf8"));
    assert.equal(checkpoint.executionComplete, false); assert.deepEqual(checkpoint.requestAccounting, run.requestAccounting);
  } finally {
    intercepted.mock.restore(); spawned.mock.restore(); syncBuiltinESMExports();
    if (prior.endpoint === undefined) delete process.env.FOUNDRY_ENDPOINT; else process.env.FOUNDRY_ENDPOINT = prior.endpoint;
    if (prior.key === undefined) delete process.env.FOUNDRY_API_KEY; else process.env.FOUNDRY_API_KEY = prior.key;
    await upstream.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("selected host SDK/CLI emits verified high/adaptive Messages with controlled-only tools and bounded native408 recovery", { timeout: 120000 }, async t => {
  const runtime = readRuntimeIdentity(), cliPath = resolveCopilotCliPath(process.env);
  for (const deployment of ["claude-haiku-5-5", "claude-opus-5-5"]) {
    const root = mkdtempSync(join(tmpdir(), "bt-native-runtime-"));
    const original: Array<Record<string, unknown>> = [], counted: string[] = [], inferred: string[] = [];
    const sdkEvents: Array<ReturnType<typeof event>> = [];
    const bridgeEvents: Array<ReturnType<typeof event>> = [];
    let toolCalls = 0;
    let exhaust = false;
    let tokenAcquisitions = 0;
    const upstream = await host((req, res) => {
      let text = ""; req.on("data", chunk => text += chunk); req.on("end", () => {
        assert.match(String(req.headers.authorization), /^Bearer fixture-token-\d+$/);
        assert.equal(req.headers["x-api-key"], undefined);
        if (req.url?.endsWith("/count_tokens")) {
          counted.push(text);
          res.writeHead(exhaust || counted.length === 1 ? 408 : 200, { "content-type": "application/json", "apim-request-id": "fixture-runtime-count" });
          res.end(exhaust || counted.length === 1 ? '{"error":{"code":"Timeout","message":"The operation was timeout."}}' : '{"input_tokens":100}');
          return;
        }
        inferred.push(text);
        const payload = JSON.parse(text);
        assert.equal(payload.model, deployment);
        assert.deepEqual(payload.thinking, { type: "adaptive", display: "summarized" });
        assert.equal(payload.output_config.effort, "high");
        assert.equal(payload.max_tokens, 8192);
        assert.deepEqual(payload.tools.map((tool: { name: string }) => tool.name), ["controlled_workspace"]);
        const tool = inferred.length === 1;
        const content = tool ? { type: "tool_use", id: "fixture-read", name: "controlled_workspace", input: {} }
          : { type: "text", text: "fixture complete" };
        const events = [
          { type: "message_start", message: { id: `fixture-${inferred.length}`, type: "message", role: "assistant",
            content: [], model: deployment, stop_reason: null, stop_sequence: null,
            usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
          { type: "content_block_start", index: 0, content_block: tool ? { ...content, input: {} } : { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: tool ? { type: "input_json_delta", partial_json: "{}" }
            : { type: "text_delta", text: "fixture complete" } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null },
            usage: { output_tokens: 5 } },
          { type: "message_stop" },
        ];
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(events.map(value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`).join(""));
      });
    });
    const g = new RequestGuard({ maxRequests: 4, maxRequestBytes: 1048576, maxTokens: 100000, maxOutputTokens: 8192,
      deadlineMs: 60000, requestsPerMinute: 60, tokensPerMinute: 100000 });
    const proxy = await startRequestSanitizingProxy(upstream.base, (body, type) => {
      original.push(JSON.parse(body.toString())); return stripTemperature(body, type);
    }, { guard: g, nativeTokenCount: { ...policy, requestTimeoutMs: 10000 }, model: deployment,
      anthropicThinking: "adaptive", reasoningEffort: "high", capture(type, data) {
        bridgeEvents.push({ ...event(bridgeEvents.length + 1, type, "2026-10-14T00:00:00Z"), data });
      } });
    const client = new CopilotClient({ mode: "empty", baseDirectory: root, workingDirectory: root, useLoggedInUser: false,
      env: scrubFoundryEnvironment(process.env), logLevel: "none",
      connection: RuntimeConnection.forStdio(cliPath ? { path: cliPath } : undefined) });
    try {
      await client.start();
      const session = await client.createSession({
        model: deployment, reasoningEffort: "high", streaming: true, enableSessionStore: false, workingDirectory: root,
        availableTools: new ToolSet().addCustom("controlled_workspace").toArray(),
        onPermissionRequest: approveAll,
        tools: [defineTool("controlled_workspace", { description: "Offline fixture controlled tool, no Docker or host filesystem access.",
          parameters: { type: "object", properties: {} }, handler: async () => { toolCalls++; return "public fixture input"; } })],
        provider: { type: "anthropic", baseUrl: proxy.baseUrl, bearerTokenProvider: bearerTokenProvider({
          mode: "entra", credential: "azure-cli", subscriptionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        }, { async getToken() { return { token: `fixture-token-${++tokenAcquisitions}`, expiresOnTimestamp: Date.now() + 60000 }; } }) },
      });
      await session.rpc.tools.initializeAndValidate();
      session.on(value => sdkEvents.push({ ...event(sdkEvents.length + 1, value.type, "2026-10-14T00:00:00Z"), data: value.data }));
      await session.sendAndWait({ prompt: "Use controlled_workspace once, then reply fixture complete." }, 30000);
      assert.equal(toolCalls, 1); assert.equal(inferred.length, 2); assert.equal(counted.length, 3);
      assert.equal(counted[0], counted[1]);
      assert.equal(counted[1], nativeCountBody(Buffer.from(inferred[0]), deployment).toString());
      assert.equal(counted[2], nativeCountBody(Buffer.from(inferred[1]), deployment).toString());
      assert.equal(g.accounting.physicalRequests, 2); assert.equal(g.accounting.ambiguousRequests, 0);
      assert.equal(g.accounting.nativeTokenCount?.requests, 3); assert.equal(g.accounting.nativeTokenCount?.retries, 1);
      const calls = extractModelCalls(sdkEvents);
      assert.equal(calls.length, 2);
      assert.equal(calls.reduce((sum, call) => sum + (call.inputTokens ?? 0), 0), 200);
      assert.equal(calls.reduce((sum, call) => sum + (call.outputTokens ?? 0), 0), 10);
      exhaust = true;
      await assert.rejects(() => session.sendAndWait({ prompt: "Fresh fixed follow-up; preserve the public fixture." }, 30000));
      await client.deleteSession(session.sessionId);
      assert.equal(counted.length, 6); assert.equal(inferred.length, 2);
      assert.equal(g.accounting.nativeTokenCount?.retries, 3);
      assert.equal(g.accounting.ambiguousRequests, 0);
      assert.equal(g.cleanlySettled(), false);
      assert.equal(extractModelCalls(sdkEvents).reduce((sum, call) => sum + (call.inputTokens ?? 0), 0), 200);
      assert.equal(createRunDiagnostics(bridgeEvents, runtime, [], "fixture native failure").providerFailure.signature, "native_token_count_failure");
      t.diagnostic(JSON.stringify({ runtime, deployment, effort: "high", thinking: "adaptive",
        initialRuntimeThinking: original[0].thinking ?? null,
        toolLayout: "host-cli-empty/custom:controlled_workspace", actualDocker: "not-probed", liveProvider: "not-probed",
        countRequests: counted.length, inferenceRequests: inferred.length, countRetries: 3,
        sdkInputTokens: 200, sdkOutputTokens: 10, feeStatus: "unknown", exhaustedFollowupInference: "not-dispatched",
        authentication: "mocked-refreshable-bearer/no-key", fakeTokenAcquisitions: tokenAcquisitions, realTokenAcquisitions: 0,
        firstCountHash: createHash("sha256").update(counted[0]).digest("hex") }));
    } finally { await client.stop(); await proxy.stop(); await upstream.close(); rmSync(root, { recursive: true, force: true }); }
  }
});
