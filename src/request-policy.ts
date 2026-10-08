import { z } from "zod";

export type DispatchCertainty = "not-dispatched" | "explicitly-rejected" | "possibly-processed";
export class DispatchError extends Error {
  constructor(message: string, public readonly certainty: DispatchCertainty, public readonly status: number | null = null) {
    super(message); this.name = "DispatchError";
  }
}
export const requestBoundsSchema = z.object({
  maxRequests: z.number().int().positive(), maxRequestBytes: z.number().int().positive().max(10 * 1024 * 1024),
  maxTokens: z.number().int().positive(), maxOutputTokens: z.number().int().positive(),
  deadlineMs: z.number().int().positive(), requestsPerMinute: z.number().int().positive(),
  tokensPerMinute: z.number().int().positive(),
}).strict();
export type RequestBounds = z.infer<typeof requestBoundsSchema>;
export interface PolicyClock { now(): number; sleep(ms: number): Promise<void>; }
export const realClock: PolicyClock = { now: Date.now, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };

export function retryDelay(headers: { get(name: string): string | null }, attempt: number, now: number, random = Math.random): number {
  const ms = Number(headers.get("retry-after-ms"));
  if (headers.get("retry-after-ms") && Number.isFinite(ms) && ms >= 0) return ms;
  const raw = headers.get("retry-after");
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(raw);
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }
  return Math.min(30000, 1000 * 2 ** attempt) * (0.75 + random() * 0.5);
}

export function canRetryRequest(certainty: DispatchCertainty, status: number | null): boolean {
  return certainty === "explicitly-rejected" && status === 429;
}

export class DeploymentAdmission {
  private readonly windows = new Map<string, { at: number; tokens: number }[]>();
  private readonly chains = new Map<string, Promise<void>>();
  constructor(private readonly clock: PolicyClock = realClock) {}
  admit(key: string, tokens: number, rpm: number, tpm: number, deadline: number): Promise<void> {
    const operation = (this.chains.get(key) ?? Promise.resolve()).then(async () => {
      if (tokens > tpm) throw new DispatchError("Single request token reservation exceeds deployment TPM bound.", "not-dispatched");
      while (true) {
        const now = this.clock.now();
        if (now >= deadline) throw new DispatchError("Request admission deadline exceeded.", "not-dispatched");
        const window = (this.windows.get(key) ?? []).filter((entry) => now - entry.at < 60000);
        this.windows.set(key, window);
        if (window.length < rpm && window.reduce((sum, e) => sum + e.tokens, 0) + tokens <= tpm) {
          window.push({ at: now, tokens }); return;
        }
        const wait = Math.max(1, window[0].at + 60000 - now);
        if (now + wait >= deadline) throw new DispatchError("Deployment pacing cannot admit before the deadline.", "not-dispatched");
        await this.clock.sleep(wait);
      }
    });
    this.chains.set(key, operation.catch(() => undefined));
    return operation;
  }
}

export class RequestGuard {
  readonly accounting = { physicalRequests: 0, reservedTokens: 0, ambiguousRequests: 0, rejectedRequests: 0 };
  private blocked = false;
  private readonly processed = new Set<string>();
  private completedResponses = 0;
  public readonly deadline: number;
  constructor(public readonly bounds?: RequestBounds, private readonly started = Date.now(), deadline?: number) {
    this.deadline = Math.min(bounds ? started + bounds.deadlineMs : deadline ?? started + 900000, deadline ?? Infinity);
  }
  reserve(bytes: number, tokens: number): void {
    if (this.blocked) throw new DispatchError("Provider lane closed after ambiguous/permanent failure; no automatic replay.", "not-dispatched");
    if (Date.now() >= this.deadline || this.bounds && (bytes > this.bounds.maxRequestBytes
        || this.accounting.physicalRequests >= this.bounds.maxRequests || this.accounting.reservedTokens + tokens > this.bounds.maxTokens)) {
      throw new DispatchError("Provider request/deadline/token protective bound reached.", "not-dispatched");
    }
    this.accounting.physicalRequests++;
    this.accounting.reservedTokens += tokens;
  }
  reject(): void { this.accounting.rejectedRequests++; }
  ambiguous(): void { this.accounting.ambiguousRequests++; this.blocked = true; }
  close(): void { this.blocked = true; }
  claim(payloadHash: string): void {
    if (this.processed.has(payloadHash)) throw new DispatchError("Duplicate possibly processed inference payload; hidden replay denied.", "not-dispatched");
    this.processed.add(payloadHash);
  }
  rejectedPayload(payloadHash: string): void { this.processed.delete(payloadHash); }
  certifyResponse(): void { this.completedResponses++; }
  cleanlySettled(): boolean {
    return this.completedResponses > 0 && !this.accounting.ambiguousRequests
      && this.completedResponses + this.accounting.rejectedRequests === this.accounting.physicalRequests;
  }
}
