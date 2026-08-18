import assert from "node:assert/strict";
import test from "node:test";
import { deriveMetrics, extractModelCalls } from "../src/metrics.js";
import { event, streamingEvents } from "./fixtures/events.js";

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
