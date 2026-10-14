import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { DispatchError, realClock, retryDelay, type PolicyClock } from "./request-policy.js";
import type { JsonRecord } from "./types.js";

export const nativeTokenCountPolicySchema = z.object({
  schemaVersion: z.literal(1),
  maxAttempts: z.number().int().min(1).max(10),
  maxRequests: z.number().int().min(1).max(10000),
  requestTimeoutMs: z.number().int().positive().max(120000),
  baseDelayMs: z.number().int().positive().max(30000),
  maxDelayMs: z.number().int().positive().max(120000),
  jitter: z.number().min(0).max(1),
  maxRetryWaitMs: z.number().int().positive().max(3600000),
  inputSafetyMarginPercent: z.number().min(0).max(100),
  inputSafetyMarginTokens: z.number().int().nonnegative().max(100000),
}).strict().refine((value) => value.baseDelayMs <= value.maxDelayMs, "baseDelayMs must not exceed maxDelayMs.");
export type NativeTokenCountPolicy = z.infer<typeof nativeTokenCountPolicySchema>;

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const nativeTokenCountAttemptSchema = z.object({
  request: count, attempt: count, inferenceBodyHash: hash, countBodyHash: hash,
  status: z.enum(["completed", "retryable-error", "error", "cancelled", "deadline"]),
  httpStatus: z.number().int().min(100).max(599).nullable(),
  code: z.string().regex(/^[a-zA-Z0-9_.-]{1,80}$/).nullable(),
  requestIds: z.record(z.string(), z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/)),
  responseBodyHash: hash.nullable(), responseBodyTruncated: z.boolean(),
  inputTokens: count.nullable(), retryAfterMs: z.number().finite().nonnegative().nullable(),
}).strict();
export const nativeTokenCountSummarySchema = z.object({
  schemaVersion: z.literal(1), requests: count, retries: count, completed: count,
  retryWaitMs: z.number().finite().nonnegative(),
  fees: z.literal("unknown"),
}).strict();
export const nativeTokenCountAccountingSchema = nativeTokenCountSummarySchema.extend({
  attempts: z.array(nativeTokenCountAttemptSchema).max(10000),
}).superRefine((value, ctx) => {
  if (value.requests !== value.attempts.length || value.retries !== value.attempts.filter((a) => a.attempt > 1).length
      || value.completed !== value.attempts.filter((a) => a.status === "completed").length
      || value.attempts.some((a, i) => a.request !== i + 1)) ctx.addIssue({
    code: "custom", message: "Native token-count accounting contradicts its separately recorded attempts.",
  });
});
export type NativeTokenCountAccounting = z.infer<typeof nativeTokenCountAccountingSchema>;
type CountAttempt = z.infer<typeof nativeTokenCountAttemptSchema>;

export function loadNativeTokenCountPolicy(path: string | undefined): NativeTokenCountPolicy | undefined {
  return path ? nativeTokenCountPolicySchema.parse(JSON.parse(readFileSync(path, "utf8"))) : undefined;
}

export class NativeTokenCountError extends DispatchError {
  constructor(public readonly code: string, status: number | null = null) {
    super(`Native token-count admission failed (${code}); no inference dispatched for this payload and no count bypass.`, "not-dispatched", status);
    this.name = "NativeTokenCountError";
  }
}

const includedFields = new Set(["model", "messages", "cache_control", "output_config", "system", "thinking", "tool_choice", "tools"]);
const excludedFields = new Set(["max_tokens", "stream", "temperature", "top_p", "top_k", "stop_sequences", "metadata", "service_tier"]);
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export function nativeCountBody(body: Buffer, model: string): Buffer {
  const value: unknown = JSON.parse(body.toString("utf8"));
  if (!isRecord(value) || value.model !== model || !Array.isArray(value.messages) || !value.messages.length
      || !Number.isSafeInteger(value.max_tokens) || Number(value.max_tokens) < 1) {
    throw new NativeTokenCountError("invalid_messages_profile");
  }
  const counted: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (includedFields.has(key)) counted[key] = item;
    else if (!excludedFields.has(key)) throw new NativeTokenCountError("unsupported_count_source_field");
  }
  return Buffer.from(JSON.stringify(counted));
}

export function applyAnthropicThinking(body: Buffer, effort: string): Buffer {
  const value: unknown = JSON.parse(body.toString("utf8"));
  if (!isRecord(value) || !["low", "medium", "high", "xhigh", "max"].includes(effort)
      || value.output_config !== undefined && !isRecord(value.output_config)
      || value.thinking !== undefined && !isRecord(value.thinking)) {
    throw new NativeTokenCountError("invalid_adaptive_thinking_profile");
  }
  // Explicit user-selected wire adaptation, not a model-name heuristic or extra thinking budget.
  const display = isRecord(value.thinking) ? value.thinking.display : undefined;
  if (display !== undefined && display !== "summarized" && display !== "omitted") {
    throw new NativeTokenCountError("invalid_adaptive_thinking_profile");
  }
  value.thinking = { type: "adaptive", ...(display !== undefined ? { display } : {}) };
  value.output_config = { ...(isRecord(value.output_config) ? value.output_config : {}), effort };
  return Buffer.from(JSON.stringify(value));
}

export interface NativeCountResponse {
  status: number;
  headers: { get(name: string): string | null };
  body: AsyncIterable<Uint8Array>;
  cancel(): void;
}
export interface NativeCountOptions {
  policy: NativeTokenCountPolicy;
  accounting: NativeTokenCountAccounting;
  deadline: number;
  signal: AbortSignal;
  model: string;
  beforeDispatch(): Promise<void>;
  beforeRetry?: (delayMs: number) => void;
  send(body: Buffer, signal: AbortSignal): Promise<NativeCountResponse>;
  capture?: (type: string, data: JsonRecord) => void;
  clock?: PolicyClock;
  random?: () => number;
}

const retryableStatuses = new Set([408, 429, 500, 502, 503, 504, 529]);
const retryableConnections = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN"]);
export function transientRateLimit(code: string | null): boolean {
  return code !== null && /^(?:rate_limit_error|rate_limit_exceeded|rate_limit|TooManyRequests|throttled)$/i.test(code);
}
export function canRetryNativeCount(status: number | null, code: string | null): boolean {
  if ((status === null || status === 200) && code !== null
      && (code === "attempt_timeout" || retryableConnections.has(code))) return true;
  if (code && /insufficient_quota|billing_hard_limit|quota[_-]?(?:exceeded|exhausted)/i.test(code)) return false;
  if (status === 429) return transientRateLimit(code);
  return status !== null ? retryableStatuses.has(status) && code !== null
    && /^(?:Timeout|timeout_error|request_timeout|attempt_timeout|api_error|internal_server_error|server_error|unavailable|overloaded_error|ServiceUnavailable)$/i.test(code)
    : code !== null && (code === "attempt_timeout" || retryableConnections.has(code));
}

export async function countNativeTokens(body: Buffer, options: NativeCountOptions): Promise<number> {
  const policy = nativeTokenCountPolicySchema.parse(options.policy);
  const clock = options.clock ?? realClock;
  const countBody = nativeCountBody(body, options.model);
  const inferenceBodyHash = digest(body), countBodyHash = digest(countBody);
  const check = () => {
    if (clock.now() >= options.deadline) throw new NativeTokenCountError("deadline");
    if (options.signal.aborted) throw new NativeTokenCountError("cancelled");
    if (options.accounting.requests >= policy.maxRequests) throw new NativeTokenCountError("request_limit");
  };
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    check();
    await options.beforeDispatch();
    check();
    const attemptTimeout = AbortSignal.timeout(Math.max(1, Math.min(policy.requestTimeoutMs, options.deadline - clock.now())));
    const signal = AbortSignal.any([options.signal, attemptTimeout]);
    const entry: CountAttempt = {
      request: ++options.accounting.requests, attempt, inferenceBodyHash, countBodyHash,
      status: "error", httpStatus: null, code: null, requestIds: {},
      responseBodyHash: null, responseBodyTruncated: false, inputTokens: null, retryAfterMs: null,
    };
    if (attempt > 1) options.accounting.retries++;
    options.accounting.attempts.push(entry);
    options.capture?.("runner.native_count_dispatch", { request: entry.request, attempt, inferenceBodyHash, countBodyHash, fees: "unknown" });
    let delay: number;
    try {
      const response = await options.send(countBody, signal);
      entry.httpStatus = response.status;
      for (const name of ["request-id", "x-request-id", "x-ms-request-id", "apim-request-id"]) {
        const id = response.headers.get(name);
        if (id && /^[a-zA-Z0-9_.-]{1,128}$/.test(id)) entry.requestIds[name] = id;
      }
      const received = await boundedResponse(response);
      entry.responseBodyHash = digest(received.body);
      entry.responseBodyTruncated = received.truncated;
      if (clock.now() >= options.deadline) throw new NativeTokenCountError("deadline");
      if (options.signal.aborted) throw new NativeTokenCountError("cancelled");
      if (signal.aborted) throw new NativeTokenCountError("attempt_timeout");
      if (response.status === 200) {
        if (received.truncated) throw new NativeTokenCountError("response_too_large", 200);
        let value: unknown;
        try { value = JSON.parse(received.body.toString("utf8")); }
        catch (error) { if (!(error instanceof SyntaxError)) throw error; throw new NativeTokenCountError("invalid_count_response", 200); }
        if (!isRecord(value) || Object.keys(value).length !== 1 || !Number.isSafeInteger(value.input_tokens) || Number(value.input_tokens) < 0) {
          throw new NativeTokenCountError("invalid_count_response", 200);
        }
        entry.inputTokens = Number(value.input_tokens);
        entry.status = "completed";
        options.accounting.completed++;
        options.capture?.("runner.native_count_completed", { ...entry });
        return entry.inputTokens;
      }
      entry.code = received.truncated ? "response_too_large" : providerErrorCode(received.body);
      delay = countRetryDelay(response.headers, policy, attempt - 1, clock.now(), options.random);
      entry.retryAfterMs = delay;
    } catch (error) {
      if (error instanceof NativeTokenCountError) entry.code = error.code;
      else entry.code = connectionCode(error);
      if (clock.now() >= options.deadline) entry.code = "deadline";
      else if (options.signal.aborted) entry.code = "cancelled";
      else if (attemptTimeout.aborted) entry.code = "attempt_timeout";
      delay = countRetryDelay(new Headers(), policy, attempt - 1, clock.now(), options.random);
    }
    const retryable = canRetryNativeCount(entry.httpStatus, entry.code)
      && !["cancelled", "deadline", "invalid_count_response", "response_too_large"].includes(entry.code ?? "");
    entry.status = entry.code === "cancelled" ? "cancelled" : entry.code === "deadline" ? "deadline" : retryable ? "retryable-error" : "error";
    options.capture?.("runner.native_count_error", { ...entry, noInferenceDispatched: true, retryable });
    if (!retryable) throw new NativeTokenCountError(entry.code ?? "http_error", entry.httpStatus);
    if (attempt === policy.maxAttempts) throw new NativeTokenCountError("attempt_limit", entry.httpStatus);
    check();
    if (clock.now() + delay >= options.deadline) throw new NativeTokenCountError("retry_deadline", entry.httpStatus);
    if (options.accounting.retryWaitMs + delay > policy.maxRetryWaitMs) throw new NativeTokenCountError("retry_wait_limit", entry.httpStatus);
    options.beforeRetry?.(delay);
    options.accounting.retryWaitMs += delay;
    options.capture?.("runner.native_count_retry", { request: entry.request, nextAttempt: attempt + 1, delayMs: delay });
    try { await clock.sleep(delay, options.signal); }
    catch (error) { if (!options.signal.aborted) throw error; throw new NativeTokenCountError("cancelled"); }
  }
  throw new NativeTokenCountError("attempt_limit");
}

function countRetryDelay(headers: { get(name: string): string | null }, policy: NativeTokenCountPolicy, attempt: number, now: number, random = Math.random): number {
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt);
  const local = Math.min(policy.maxDelayMs, exponential * (1 - policy.jitter + random() * policy.jitter));
  // A provider minimum is never clipped to our local backoff cap.
  const provider = Math.max(...["retry-after", "retry-after-ms"].map(name => headers.get(name)
    ? retryDelay({ get: key => key === name ? headers.get(name) : null }, attempt, now, () => 0) : 0));
  return Math.max(local, provider);
}

async function boundedResponse(response: NativeCountResponse): Promise<{ body: Buffer; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of response.body) {
    const available = Math.max(0, 65536 - length);
    chunks.push(Buffer.from(chunk.subarray(0, available)));
    length += chunk.length;
    if (length > 65536) { response.cancel(); return { body: Buffer.concat(chunks), truncated: true }; }
  }
  return { body: Buffer.concat(chunks), truncated: false };
}

function connectionCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string" && retryableConnections.has(error.code)) return error.code;
  return "transport_error";
}
export function providerErrorCode(bytes: Buffer): string | null {
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch (error) { if (!(error instanceof SyntaxError)) throw error; return "invalid_error_response"; }
  if (!isRecord(value)) return null;
  if ("error" in value && !isRecord(value.error)) return "invalid_error_category";
  const error = isRecord(value.error) ? value.error : value;
  const categories = ["code", "type"].filter(key => key in error).map(key => error[key]);
  if (!categories.length) return null;
  if (categories.some(code => typeof code !== "string" || !/^[a-zA-Z0-9_.-]{1,80}$/.test(code))) return "invalid_error_category";
  if (categories.length > 1 && categories[0] !== categories[1]) return "contradictory_error_category";
  return String(categories[0]);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
