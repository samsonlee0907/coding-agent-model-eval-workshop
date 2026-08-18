import { optionalNumber, optionalString } from "./json.js";
import type { DerivedMetrics, Metric, ModelCall, NormalizedEvent, ToolCall } from "./types.js";

export function extractModelCalls(events: readonly NormalizedEvent[]): ModelCall[] {
  return events
    .filter((event) => event.eventType === "assistant.usage")
    .map((event) => ({
      eventId: event.eventId,
      agentId: event.agentId,
      timestamp: event.eventTimestamp ?? event.recordedAt,
      model: optionalString(event.data.model),
      inputTokens: optionalNumber(event.data.inputTokens),
      outputTokens: optionalNumber(event.data.outputTokens),
      reasoningTokens: optionalNumber(event.data.reasoningTokens),
      cacheReadTokens: optionalNumber(event.data.cacheReadTokens),
      cacheWriteTokens: optionalNumber(event.data.cacheWriteTokens),
      cost: optionalNumber(event.data.cost),
      durationMs: optionalNumber(event.data.duration),
      sdkTimeToFirstTokenMs: optionalNumber(event.data.timeToFirstTokenMs),
      sdkInterTokenLatencyMs: optionalNumber(event.data.interTokenLatencyMs),
      finishReason: optionalString(event.data.finishReason),
    }));
}

export function extractToolCalls(events: readonly NormalizedEvent[]): ToolCall[] {
  const calls = new Map<string, ToolCall>();
  for (const event of events) {
    if (event.eventType !== "tool.execution_start" && event.eventType !== "tool.execution_complete") {
      continue;
    }
    const id = optionalString(event.data.toolCallId) ?? event.eventId ?? `event-${event.sequence}`;
    const existing = calls.get(id) ?? {
      toolCallId: optionalString(event.data.toolCallId),
      toolName: optionalString(event.data.toolName) ?? optionalString(event.data.name),
      agentId: event.agentId,
      startedAt: null,
      completedAt: null,
      resultType: null,
      error: null,
    };
    if (event.eventType === "tool.execution_start") {
      existing.startedAt = event.eventTimestamp ?? event.recordedAt;
    } else {
      existing.completedAt = event.eventTimestamp ?? event.recordedAt;
      existing.resultType = optionalString(event.data.resultType);
      existing.error = optionalString(event.data.error);
    }
    calls.set(id, existing);
  }
  return [...calls.values()];
}

export function deriveMetrics(events: readonly NormalizedEvent[], modelCalls: readonly ModelCall[]): DerivedMetrics {
  const runStart = findEventTime(events, "runner.run_started");
  const runEnd = findEventTime(events, "runner.run_finished");
  const firstTool = firstOf(events, "tool.execution_start");
  const firstEdit = events.find((event) =>
    event.eventType === "tool.execution_start" && isEditTool(event.data.toolName ?? event.data.name),
  );
  const greenTest = events.find((event) =>
    event.eventType === "runner.validation_finished" && event.data.exitCode === 0,
  );
  const firstDelta = events.find((event) => event.eventType === "assistant.message_delta");
  const firstTurn = events.find((event) => event.eventType === "assistant.turn_start");
  const sdkTtft = modelCalls.find((call) => call.sdkTimeToFirstTokenMs !== null)?.sdkTimeToFirstTokenMs ?? null;
  const sdkTpot = modelCalls.find((call) => call.sdkInterTokenLatencyMs !== null)?.sdkInterTokenLatencyMs ?? null;

  return {
    e2eMs: durationMetric(runStart, runEnd, "runner event timestamps"),
    timeToFirstToolCallMs: durationMetric(runStart, firstTool, "runner to first tool.execution_start"),
    timeToFirstEditMs: durationMetric(runStart, firstEdit, "runner to first edit-like tool"),
    timeToGreenTestMs: durationMetric(runStart, greenTest, "runner to deterministic validation success"),
    timeToFirstTokenMs: firstDelta
      ? sdkTtft !== null
        ? available(sdkTtft, "assistant.usage.timeToFirstTokenMs with observed streaming delta")
        : durationMetric(firstTurn, firstDelta, "assistant.turn_start to first assistant.message_delta")
      : unavailable("No assistant.message_delta was captured; TTFT is not inferred from a final message."),
    timePerOutputTokenMs: sdkTpot !== null
      ? available(sdkTpot, "assistant.usage.interTokenLatencyMs")
      : unavailable("SDK did not emit assistant.usage.interTokenLatencyMs."),
    inputTokens: sumMetric(modelCalls.map((call) => call.inputTokens), "assistant.usage.inputTokens"),
    outputTokens: sumMetric(modelCalls.map((call) => call.outputTokens), "assistant.usage.outputTokens"),
    cacheReadTokens: sumMetric(modelCalls.map((call) => call.cacheReadTokens), "assistant.usage.cacheReadTokens"),
    cacheWriteTokens: sumMetric(modelCalls.map((call) => call.cacheWriteTokens), "assistant.usage.cacheWriteTokens"),
    cost: sumMetric(modelCalls.map((call) => call.cost), "assistant.usage.cost"),
  };
}

function findEventTime(events: readonly NormalizedEvent[], type: string): NormalizedEvent | undefined {
  return events.find((event) => event.eventType === type);
}

function firstOf(events: readonly NormalizedEvent[], type: string): NormalizedEvent | undefined {
  return events.find((event) => event.eventType === type);
}

function durationMetric(start: NormalizedEvent | undefined, end: NormalizedEvent | undefined, source: string): Metric<number> {
  if (!start || !end) {
    return unavailable(`Required event missing for ${source}.`);
  }
  const started = Date.parse(start.eventTimestamp ?? start.recordedAt);
  const completed = Date.parse(end.eventTimestamp ?? end.recordedAt);
  if (Number.isNaN(started) || Number.isNaN(completed)) {
    return unavailable(`Invalid timestamps for ${source}.`);
  }
  return available(Math.max(0, completed - started), source);
}

function sumMetric(values: Array<number | null>, source: string): Metric<number> {
  const present = values.filter((value): value is number => value !== null);
  return present.length === 0
    ? unavailable(`No ${source} values were emitted.`)
    : available(present.reduce((total, value) => total + value, 0), source);
}

function available(value: number, source: string): Metric<number> {
  return { status: "available", value, source };
}

function unavailable(reason: string): Metric<number> {
  return { status: "unavailable", value: null, reason };
}

function isEditTool(value: unknown): boolean {
  return typeof value === "string" && /(edit|write|apply_patch|create_file)/i.test(value);
}
