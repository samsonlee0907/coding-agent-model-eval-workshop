import type { NormalizedEvent } from "../../src/types.js";

export function event(
  sequence: number,
  eventType: string,
  timestamp: string,
  data: Record<string, string | number | boolean | null> = {},
): NormalizedEvent {
  return {
    schemaVersion: 1,
    sequence,
    recordedAt: timestamp,
    source: "sdk",
    eventType,
    eventId: `event-${sequence}`,
    parentEventId: sequence === 1 ? null : `event-${sequence - 1}`,
    agentId: null,
    eventTimestamp: timestamp,
    ephemeral: eventType.includes("delta") || eventType === "assistant.usage",
    data,
  };
}

export const streamingEvents: NormalizedEvent[] = [
  event(1, "runner.run_started", "2026-08-18T00:00:00.000Z"),
  event(2, "assistant.turn_start", "2026-08-18T00:00:01.000Z"),
  event(3, "assistant.message_delta", "2026-08-18T00:00:01.250Z", { deltaContent: "I" }),
  event(4, "tool.execution_start", "2026-08-18T00:00:02.000Z", { toolCallId: "tool-1", toolName: "apply_patch" }),
  event(5, "assistant.usage", "2026-08-18T00:00:03.000Z", {
    model: "gpt-test",
    inputTokens: 100,
    outputTokens: 25,
    cacheReadTokens: 50,
    cost: 0.5,
    timeToFirstTokenMs: 200,
    interTokenLatencyMs: 8,
  }),
  event(6, "runner.validation_finished", "2026-08-18T00:00:04.000Z", { exitCode: 0 }),
  event(7, "runner.run_finished", "2026-08-18T00:00:05.000Z"),
];
