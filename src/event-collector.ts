import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { asRecord, optionalString, toJsonValue } from "./json.js";
import type { JsonRecord, JsonValue, NormalizedEvent, RawEventRecord } from "./types.js";
import { appendJournal, atomicWrite, readJournal } from "./durable.js";

export class EventCollector {
  private sequence = 0;
  private readonly normalized: NormalizedEvent[] = [];

  public constructor(
    public readonly rawEventsPath: string,
    public readonly normalizedEventsPath: string,
    private readonly onEvent?: (event: NormalizedEvent) => void,
  ) {
    mkdirSync(dirname(rawEventsPath), { recursive: true });
    mkdirSync(dirname(normalizedEventsPath), { recursive: true });
    const raw = readJournal(rawEventsPath, (value) => {
      const record = value as RawEventRecord;
      if (record.schemaVersion !== 1 || !Number.isSafeInteger(record.sequence) || record.sequence < 1
          || (record.source !== "sdk" && record.source !== "runner")) throw new TypeError("Invalid event journal record.");
      return record;
    });
    for (const record of raw) {
      if (record.sequence !== this.sequence + 1) throw new Error("Non-contiguous event journal sequence.");
      this.normalized.push(normalize(record));
      this.sequence = record.sequence;
    }
    atomicWrite(normalizedEventsPath, this.normalized.map((event) => `${JSON.stringify(event)}\n`).join(""));
  }

  public captureSdkEvent(event: unknown): NormalizedEvent {
    return this.capture("sdk", event);
  }

  public captureRunnerEvent(type: string, data: JsonRecord = {}): NormalizedEvent {
    return this.capture("runner", { type, data });
  }

  public events(): readonly NormalizedEvent[] {
    return this.normalized;
  }

  private capture(source: "sdk" | "runner", envelope: unknown): NormalizedEvent {
    const jsonEnvelope = toJsonValue(envelope);
    if (jsonEnvelope === undefined) {
      throw new TypeError("Cannot serialize a non-JSON SDK event envelope.");
    }

    const sequence = ++this.sequence;
    const receivedAt = new Date().toISOString();
    const raw: RawEventRecord = {
      schemaVersion: 1,
      sequence,
      receivedAt,
      source,
      envelope: jsonEnvelope,
    };
    const normalized = normalize(raw);
    appendJournal(this.rawEventsPath, raw);
    appendJournal(this.normalizedEventsPath, normalized);
    this.normalized.push(normalized);
    this.onEvent?.(normalized);
    return normalized;
  }
}

export function normalize(raw: RawEventRecord): NormalizedEvent {
  const envelope = asRecord(raw.envelope);
  const data = asRecord(envelope.data);
  return {
    schemaVersion: 1,
    sequence: raw.sequence,
    recordedAt: raw.receivedAt,
    source: raw.source,
    eventType: optionalString(envelope.type) ?? "unknown",
    eventId: optionalString(envelope.id),
    parentEventId: optionalString(envelope.parentId),
    agentId: optionalString(envelope.agentId),
    eventTimestamp: optionalString(envelope.timestamp),
    ephemeral: typeof envelope.ephemeral === "boolean" ? envelope.ephemeral : null,
    data,
  };
}
