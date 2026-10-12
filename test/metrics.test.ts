import assert from "node:assert/strict";
import test from "node:test";
import { deriveMetrics, extractModelCalls } from "../src/metrics.js";
import { event, streamingEvents } from "./fixtures/events.js";
import { providerTerminal } from "../src/provider-stream.js";

test("derives streaming, tool, cache, and validation metrics from event fixtures", () => {
  const metrics = deriveMetrics(streamingEvents, extractModelCalls(streamingEvents));
  assert.deepEqual(metrics.timeToFirstTokenMs, {
    status: "available",
    value: 200,
    source: "assistant.usage.timeToFirstTokenMs with observed streaming delta",
  });
  assert.equal(metrics.timeToFirstToolCallMs.value, 2_000);
  assert.equal(metrics.timeToFirstEditMs.value, 2_000);
  assert.equal(metrics.timeToGreenTestMs.value, 4_000);
  assert.equal(metrics.cacheReadTokens.value, 50);
  assert.equal(metrics.cost.value, 0.5);
});

test("does not invent TTFT when no streamed delta exists", () => {
  const events = [
    event(1, "runner.run_started", "2026-08-18T00:00:00.000Z"),
    event(2, "assistant.turn_start", "2026-08-18T00:00:01.000Z"),
    event(3, "assistant.message", "2026-08-18T00:00:02.000Z", { content: "final only" }),
  ];
  const metrics = deriveMetrics(events, extractModelCalls(events));
  assert.equal(metrics.timeToFirstTokenMs.status, "unavailable");
  assert.match(metrics.timeToFirstTokenMs.reason ?? "", /message_delta/);
});

test("known terminal usage includes failed work without adding SDK or reasoning counters twice", () => {
  const terminal = (type: "completed" | "incomplete", input: number, output: number) => providerTerminal({
    type: `response.${type}`, response: { status: type, output: [],
      incomplete_details: type === "incomplete" ? { reason: "max_output_tokens" } : null,
      usage: { input_tokens: input, output_tokens: output, total_tokens: input + output,
        input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: output - 1 } } },
  }, true)!;
  const events = [
    event(1, "assistant.usage", "2026-10-12T00:00:00Z", { inputTokens: 10, outputTokens: 5, cost: 0.1 }),
    { ...event(2, "runner.provider_terminal", "2026-10-12T00:00:00Z"), data: { request: 1, terminal: terminal("completed", 10, 5) } },
    { ...event(3, "runner.provider_terminal", "2026-10-12T00:00:01Z"), data: { request: 2, terminal: terminal("incomplete", 20, 7) } },
  ];
  const metrics = deriveMetrics(events, extractModelCalls(events));
  assert.equal(metrics.inputTokens.value, 30); assert.equal(metrics.outputTokens.value, 12);
  assert.equal(metrics.cacheReadTokens.value, 4); assert.equal(metrics.cacheWriteTokens.value, null);
  assert.equal(metrics.cost.value, 0.1);
  assert.match(metrics.outputTokens.source!, /known subtotal including failed responses/);
  const old = events.slice(0, 1);
  assert.equal(deriveMetrics(old, extractModelCalls(old)).inputTokens.value, 10);
});
