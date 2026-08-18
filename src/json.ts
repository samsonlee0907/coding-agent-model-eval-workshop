import type { JsonRecord, JsonValue } from "./types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown): JsonRecord {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      const normalized = toJsonValue(item);
      return normalized === undefined ? [] : [[key, normalized]];
    }),
  );
}

export function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const normalized = toJsonValue(item);
      return normalized === undefined ? [] : [normalized];
    });
  }
  if (isRecord(value)) {
    return asRecord(value);
  }
  return undefined;
}

export function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
