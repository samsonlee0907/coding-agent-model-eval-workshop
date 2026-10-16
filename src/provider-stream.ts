import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import { DispatchError } from "./request-policy.js";

const eventTypes = ["response.completed", "response.incomplete", "response.failed", "error", "provider.error"] as const;
const statuses = ["completed", "incomplete", "failed", "cancelled", "in_progress", "queued", "other"] as const;
const reasons = ["max_output_tokens", "max_messages", "content_filter", "steered", "other"] as const;
const errorCodes = [
  "server_error", "rate_limit_exceeded", "invalid_prompt", "data_residency_mismatch", "bio_policy",
  "misalignment_policy_violation", "vector_store_timeout", "invalid_image", "invalid_image_format",
  "invalid_base64_image", "invalid_image_url", "image_too_large", "image_too_small", "image_parse_error",
  "image_content_policy_violation", "invalid_image_mode", "image_file_too_large",
  "unsupported_image_media_type", "empty_image_file", "failed_to_download_image", "image_file_not_found",
  "content_filter", "context_length_exceeded", "insufficient_quota", "other",
] as const;
const tokens = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
export const providerUsageSchema = z.object({
  inputTokens: tokens, outputTokens: tokens, totalTokens: tokens, reasoningTokens: tokens,
  cacheReadTokens: tokens, cacheWriteTokens: tokens,
}).strict().superRefine((usage, ctx) => {
  if (usage.inputTokens !== null && usage.outputTokens !== null && usage.totalTokens !== null
      && usage.inputTokens + usage.outputTokens !== usage.totalTokens
      || usage.outputTokens !== null && usage.reasoningTokens !== null && usage.reasoningTokens > usage.outputTokens
      || usage.inputTokens !== null && usage.cacheReadTokens !== null && usage.cacheReadTokens > usage.inputTokens
      || usage.inputTokens !== null && usage.cacheWriteTokens !== null && usage.cacheWriteTokens > usage.inputTokens) {
    ctx.addIssue({ code: "custom", message: "Provider token counters contradict their inclusive totals." });
  }
});
export const providerTerminalSchema = z.object({
  eventType: z.enum(eventTypes), responseStatus: z.enum(statuses).nullable(),
  incompleteReason: z.enum(reasons).nullable(), errorCode: z.enum(errorCodes).nullable(),
  terminalResponse: z.boolean(), maxOutputTokens: tokens,
  usage: providerUsageSchema.nullable(), usageStatus: z.enum(["reported", "partial", "missing", "invalid"]),
}).strict().superRefine((terminal, ctx) => {
  if (terminal.usageStatus === "reported" && (terminal.usage?.inputTokens === null
      || terminal.usage?.inputTokens === undefined || terminal.usage.outputTokens === null)
      || ["missing", "invalid"].includes(terminal.usageStatus) && terminal.usage !== null) {
    ctx.addIssue({ code: "custom", message: "Provider usage availability contradicts its reported counters." });
  }
  if (terminal.terminalResponse && !(
    terminal.eventType === "response.completed" && terminal.responseStatus === "completed" && terminal.incompleteReason === null && terminal.errorCode === null
    || terminal.eventType === "response.incomplete" && terminal.responseStatus === "incomplete"
    || terminal.eventType === "response.failed" && ["failed", "cancelled"].includes(terminal.responseStatus ?? ""))) {
    ctx.addIssue({ code: "custom", message: "Provider terminal event/status contradict completion evidence." });
  }
});
export type ProviderTerminalEvidence = z.infer<typeof providerTerminalSchema>;

export class ProviderTerminalError extends DispatchError {
  constructor(public readonly terminal: ProviderTerminalEvidence) {
    const guidance = terminal.errorCode === "rate_limit_exceeded"
      ? "Provider rate limit signaled after dispatch. Review deployment-specific RPM/TPM, short-window pacing and shared traffic; allow cooldown before a separately authorized new attempt. Processing and usage may be unknown."
      : terminal.terminalResponse && terminal.incompleteReason === "max_output_tokens"
      ? "Output allowance exhausted. maxOutputTokens includes reasoning and visible output; explicitly review a finite allowance and total token budget in a new cohort."
      : terminal.incompleteReason === "content_filter" || terminal.errorCode === "content_filter"
        ? "Provider content filtering interrupted generation."
        : "Provider reported a failed, incomplete or invalid terminal response.";
    super(`${guidance} No automatic replay or success certification.`, "possibly-processed");
  }
}

/** Only categorical owner-schema fields and validated counters may leave the provider body. */
export function providerTerminal(value: unknown, streaming: boolean): ProviderTerminalEvidence | null {
  if (!record(value)) return null;
  const type = streaming ? value.type : value.status === "completed" ? "response.completed"
    : value.status === "incomplete" ? "response.incomplete" : value.status === "failed" || value.status === "cancelled" ? "response.failed" : null;
  const eventType = eventTypes.find((known) => known === type) ?? (value.error ? "provider.error" : null);
  if (!eventType) return null;
  const response = streaming ? record(value.response) ? value.response : {} : value;
  const error = record(response.error) ? response.error : record(value.error) ? value.error
    : eventType === "error" || eventType === "provider.error" ? value : {};
  const incomplete = record(response.incomplete_details) ? response.incomplete_details : {};
  const usage = record(response.usage) ? response.usage : null;
  const hasUsage = response.usage !== undefined && response.usage !== null;
  const inputDetails = usage && record(usage.input_tokens_details) ? usage.input_tokens_details : {};
  const outputDetails = usage && record(usage.output_tokens_details) ? usage.output_tokens_details : {};
  const usageResult = usage ? providerUsageSchema.safeParse({
    inputTokens: usage.input_tokens ?? null, outputTokens: usage.output_tokens ?? null, totalTokens: usage.total_tokens ?? null,
    reasoningTokens: outputDetails.reasoning_tokens ?? null, cacheReadTokens: inputDetails.cached_tokens ?? null,
    cacheWriteTokens: inputDetails.cache_write_tokens ?? null,
  }) : null;
  const reported = usageResult?.success && Object.values(usageResult.data).some((count) => count !== null) ? usageResult.data : null;
  const status = category(response.status, statuses);
  return {
    eventType, responseStatus: status, incompleteReason: category(incomplete.reason, reasons),
    errorCode: category(error.code, errorCodes),
    terminalResponse: Array.isArray(response.output) && (
      eventType === "response.completed" && status === "completed" && response.error == null && value.error == null && response.incomplete_details == null
      || eventType === "response.incomplete" && status === "incomplete"
      || eventType === "response.failed" && (status === "failed" || status === "cancelled")),
    maxOutputTokens: typeof response.max_output_tokens === "number" && Number.isSafeInteger(response.max_output_tokens)
      && response.max_output_tokens > 0 ? response.max_output_tokens : null,
    usage: reported,
    usageStatus: !hasUsage ? "missing" : !usageResult?.success ? "invalid"
      : reported?.inputTokens !== null && reported?.inputTokens !== undefined
        && reported.outputTokens !== null ? "reported" : "partial",
  };
}

function category<const T extends readonly string[]>(value: unknown, allowed: T): T[number] | "other" | null {
  return value === undefined || value === null ? null : allowed.find((known) => known === value) ?? "other";
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** SSE data fields form one UTF-8 event; transport chunks are not lines/events. */
export class ProviderStream {
  private readonly decoder = new StringDecoder("utf8");
  private line = "";
  private data: string[] = [];
  private eventType = "";
  private skipLf = false;
  private eventBytes = 0;
  private terminal = false;
  private observedTerminal = false;
  private first = true;
  constructor(private readonly route: string, private readonly onTerminal?: (evidence: ProviderTerminalEvidence) => void) {}
  push(chunk: Buffer): void { this.read(this.decoder.write(chunk)); }
  finish(): void {
    this.read(this.decoder.end());
    if (this.line || this.data.length) throw new DispatchError("Provider stream ended inside an SSE event.", "possibly-processed");
    if (!this.terminal) throw new DispatchError("Provider stream ended without valid completion evidence.", "possibly-processed");
  }
  private read(text: string): void {
    for (const char of text) {
      if (this.first) { this.first = false; if (char === "\uFEFF") continue; }
      if (this.skipLf && char === "\n") { this.skipLf = false; continue; }
      this.skipLf = false;
      this.eventBytes += Buffer.byteLength(char);
      if (this.eventBytes > 16 * 1024 * 1024) throw new DispatchError("Provider SSE event exceeds the 16 MiB byte bound.", "possibly-processed");
      if (char === "\r" || char === "\n") {
        this.acceptLine(); this.skipLf = char === "\r";
      } else this.line += char;
    }
  }
  private acceptLine(): void {
    const line = this.line; this.line = "";
    if (line === "") {
      if (this.data.length) this.acceptEvent(this.data.join("\n"));
      this.data = []; this.eventType = ""; this.eventBytes = 0; return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.data.push(value);
    if (field === "event") this.eventType = value;
  }
  private acceptEvent(data: string): void {
    const responses = this.route.split("?")[0].endsWith("/responses");
    const messages = this.route.split("?")[0].endsWith("/messages");
    if (data === "[DONE]") {
      if (!responses && !messages) this.terminal = true;
      return;
    }
    let event: unknown;
    try { event = JSON.parse(data); }
    catch { throw new DispatchError("Malformed provider SSE event JSON.", "possibly-processed"); }
    if (!event || typeof event !== "object" || Array.isArray(event)) throw new DispatchError("Invalid provider SSE event.", "possibly-processed");
    const record = event as Record<string, unknown>;
    if (eventTypes.some((type) => type === this.eventType) && typeof record.type === "string" && this.eventType !== record.type) {
      throw new DispatchError("Provider SSE event/data types disagree; no completion certification.", "possibly-processed");
    }
    const evidence = providerTerminal(record.type === undefined && this.eventType ? { ...record, type: this.eventType } : record, true);
    if (evidence && (responses || evidence.eventType === "error" || evidence.eventType === "provider.error")) {
      if (this.observedTerminal) throw new ProviderTerminalError({ ...evidence, terminalResponse: false });
      this.observedTerminal = true;
      this.onTerminal?.(evidence);
      if (evidence.eventType !== "response.completed" || !evidence.terminalResponse) {
        throw new ProviderTerminalError(evidence);
      }
      this.terminal = true;
    }
    if (messages && record.type === "message_stop") this.terminal = true;
  }
}
