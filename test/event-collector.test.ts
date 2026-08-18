import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EventCollector, normalize } from "../src/event-collector.js";
import type { RawEventRecord } from "../src/types.js";

test("normalizes SDK envelope identifiers while preserving raw NDJSON", () => {
  const directory = mkdtempSync(join(tmpdir(), "benchmark-events-"));
  const collector = new EventCollector(join(directory, "raw.ndjson"), join(directory, "normalized.ndjson"));
  collector.captureSdkEvent({
    id: "sdk-event",
    parentId: "parent-event",
    agentId: "subagent-1",
    timestamp: "2026-08-18T00:00:00.000Z",
    ephemeral: true,
    type: "assistant.message_delta",
    data: { deltaContent: "hello" },
  });

  const normalized = collector.events()[0];
  assert.equal(normalized.eventId, "sdk-event");
  assert.equal(normalized.parentEventId, "parent-event");
  assert.equal(normalized.agentId, "subagent-1");
  assert.equal(normalized.ephemeral, true);
  assert.match(readFileSync(join(directory, "raw.ndjson"), "utf8"), /assistant\.message_delta/);
});

test("unknown event payloads remain schema-tolerant", () => {
  const raw: RawEventRecord = {
    schemaVersion: 1,
    sequence: 1,
    receivedAt: "2026-08-18T00:00:00.000Z",
    source: "sdk",
    envelope: { type: "future.event", data: { futureField: "kept" } },
  };
  const normalized = normalize(raw);
  assert.equal(normalized.eventType, "future.event");
  assert.equal(normalized.data.futureField, "kept");
});
