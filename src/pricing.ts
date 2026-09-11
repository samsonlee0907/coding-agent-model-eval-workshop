import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { BenchmarkRun, Metric } from "./types.js";

export const azureOpenAiPricingUrl = "https://azure.microsoft.com/en-us/pricing/details/azure-openai/";
export const anthropicClaudePricingUrl = "https://claude.com/pricing#api";
export const foundryClaudeBillingUrl = "https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/claude-models-billing";
export const anthropicExtendedCachePricingUrl = "https://platform.claude.com/docs/en/build-with-claude/prompt-caching#1-hour-cache-duration";

type Provider = "openai" | "anthropic";
export type CacheTtl = "5m" | "1h";
export interface TokenPrice { kind: "input" | "cached-input" | "cache-write" | "output"; retailPrice: number; region: string | null; cacheTtl: CacheTtl | null; }
export interface PricingScenario {
  id: string; provider: Provider; officialModel: string; region: string | null; cacheTtl: CacheTtl | null;
  input: TokenPrice | null; cachedInput: TokenPrice | null; cacheWrite: TokenPrice | null; output: TokenPrice | null; unavailableReason: string | null;
}
export interface CandidatePricing {
  candidate: string; recorded: { provider: string; model: string; deployment: string | null };
  sourceUrl: string | null; scenarios: PricingScenario[]; unavailableReason: string | null;
}
export interface PricingSnapshot {
  schemaVersion: 1; refreshedAt: string; regionFilter: string | null; currency: "USD";
  sources: Array<{ provider: Provider; pricingUrl: string; documentationUrl: string | null; extendedCachePricingUrl: string | null }>;
  candidates: CandidatePricing[];
}
export interface PricingFetchResponse { ok: boolean; status: number; statusText: string; text(): Promise<string>; }
export type PricingFetch = (url: string) => Promise<PricingFetchResponse>;
export interface RefreshPricingOptions { region?: string; modelOverrides?: Readonly<Record<string, string>>; fetch?: PricingFetch; now?: () => Date; }
export interface RunPriceEstimate { totalUsd: number | null; unavailableReason: string | null; accountingAssumption: string | null; }

const meters = ["input", "cachedInput", "cacheWrite", "output"] as const;
type Meter = typeof meters[number];
const limit = 8 * 1024 * 1024;

export function candidateKey(run: BenchmarkRun): string {
  const candidate = run.contract.candidate;
  return `${candidate.provider}/${candidate.model}${candidate.deployment ? `/${candidate.deployment}` : ""}`;
}

export async function refreshPricingSnapshot(runs: readonly BenchmarkRun[], options: RefreshPricingOptions = {}): Promise<PricingSnapshot> {
  const records = [...new Map(runs.map((run) => [candidateKey(run), run])).values()];
  const providers = new Set(records.map((run) => run.contract.candidate.provider));
  const regionFilter = options.region?.trim().toLowerCase() || null;
  if (regionFilter !== null && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(regionFilter)) throw new TypeError("region must be a pricing-page value such as us-east.");
  const pages = await Promise.all([
    providers.has("openai") ? fetchPage(options.fetch, azureOpenAiPricingUrl) : Promise.resolve(""),
    providers.has("anthropic") ? fetchPage(options.fetch, anthropicClaudePricingUrl) : Promise.resolve(""),
  ]);
  const azure = pages[0] ? azureRows(pages[0]) : [];
  const claude = pages[1] ? claudeRows(pages[1]) : [];
  return {
    schemaVersion: 1, refreshedAt: (options.now ?? (() => new Date()))().toISOString(), regionFilter, currency: "USD",
    sources: [
      ...(providers.has("openai") ? [{ provider: "openai" as const, pricingUrl: azureOpenAiPricingUrl, documentationUrl: null, extendedCachePricingUrl: null }] : []),
      ...(providers.has("anthropic") ? [{ provider: "anthropic" as const, pricingUrl: anthropicClaudePricingUrl, documentationUrl: foundryClaudeBillingUrl, extendedCachePricingUrl: anthropicExtendedCachePricingUrl }] : []),
    ],
    candidates: records.map((run) => candidatePricing(run, run.contract.candidate.provider === "openai" ? azure : claude, regionFilter, options.modelOverrides ?? {})),
  };
}

export function writePricingSnapshot(snapshot: PricingSnapshot, path: string): void {
  assertSnapshot(snapshot);
  writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

export function loadPricingSnapshot(directory: string): PricingSnapshot | null {
  try { return parsePricingSnapshot(readFileSync(join(resolve(directory), "pricing-snapshot.json"), "utf8")); }
  catch (error) { if (isCode(error, "ENOENT")) return null; throw error; }
}

export function parsePricingSnapshot(value: string): PricingSnapshot {
  const parsed: unknown = JSON.parse(value);
  assertSnapshot(parsed);
  return parsed;
}

export function estimateRunPriceUsd(run: BenchmarkRun, snapshot: PricingSnapshot | null, scenarioId?: string, anthropicAccounting?: "sdk-inclusive" | "native-uncached"): RunPriceEstimate {
  if (!snapshot) return unavailable("No saved pricing snapshot. Run prices:refresh first.");
  const candidate = snapshot.candidates.find((entry) => entry.candidate === candidateKey(run));
  const scenario = candidate?.scenarios.find((entry) => entry.id === scenarioId);
  if (!scenarioId || !scenario) return unavailable("Select an explicit saved pricing scenario; no billing default is inferred.");
  if (scenario.unavailableReason || !scenario.input || !scenario.output) return unavailable(scenario.unavailableReason ?? "The selected scenario lacks input or output rates.");
  if (scenario.provider === "anthropic" && !anthropicAccounting) return unavailable("Claude input accounting is unverified; choose the labelled SDK-inclusive or native-uncached assumption.");
  const values = Object.fromEntries(meters.map((field) => [field, metric(run.metrics[field === "cachedInput" ? "cacheReadTokens" : field === "cacheWrite" ? "cacheWriteTokens" : `${field}Tokens` as "inputTokens" | "outputTokens"])])) as Record<Meter, number | null>;
  if (Object.values(values).some((value) => value === null)) return unavailable("Complete captured input, cache-read, cache-write, and output telemetry is required.");
  const input = values.input!, reads = values.cachedInput!, writes = values.cacheWrite!, output = values.output!;
  const inclusive = scenario.provider === "openai" || anthropicAccounting === "sdk-inclusive";
  const fresh = inclusive ? input - reads - writes : input;
  if (fresh < 0) return unavailable("Cache reads plus writes exceed inclusive input; fresh input cannot be negative.");
  if ((reads > 0 && !scenario.cachedInput) || (writes > 0 && !scenario.cacheWrite)) return unavailable("The selected scenario lacks a rate for a used cache meter.");
  const price = (tokens: number, meter: TokenPrice | null) => tokens === 0 ? 0 : tokens * meter!.retailPrice / 1_000_000;
  const totalUsd = price(fresh, scenario.input) + price(reads, scenario.cachedInput) + price(writes, scenario.cacheWrite) + price(output, scenario.output);
  return { totalUsd, unavailableReason: null, accountingAssumption: scenario.provider === "anthropic" ? `${anthropicAccounting}; scenario TTL ${scenario.cacheTtl} is an estimate, not observed billing.` : "Official regional list-price scenario, not actual billing." };
}

export function sdkReportedCacheShare(run: BenchmarkRun): { ratio: number | null; reason: string | null } {
  const input = metric(run.metrics.inputTokens), reads = metric(run.metrics.cacheReadTokens);
  if (input === null || reads === null || input === 0 || reads > input) return { ratio: null, reason: "Requires complete SDK input and cache-read counters with positive input and reads not exceeding input." };
  return { ratio: reads / input, reason: null };
}

async function fetchPage(custom: PricingFetch | undefined, url: string): Promise<string> {
  const response = custom ? await custom(url) : await fetch(url, { redirect: "error", signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Official pricing page ${url} returned ${response.status} ${response.statusText}.`);
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > limit) throw new RangeError(`Official pricing page ${url} exceeds the size limit.`);
  return text;
}

interface Row { label: string; rates: Record<Meter, Record<string, number | null>>; }
function emptyRates(): Record<Meter, Record<string, number | null>> { return { input: {}, cachedInput: {}, cacheWrite: {}, output: {} }; }
function azureRows(html: string): Row[] {
  return [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].flatMap((match) => {
    const cells = [...match[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => cell[1]);
    if (cells.length < 2 || !/data-amount/i.test(cells[1])) return [];
    const rates = emptyRates();
    for (const line of cells[1].split(/<br\s*\/?>/i)) {
      const kind = /cached\s*input|cached?\s*reads?/i.test(line) ? "cachedInput" : /cache\s*writes?/i.test(line) ? "cacheWrite" : /^\s*input\s*:/i.test(strip(line)) ? "input" : /^\s*output\s*:/i.test(strip(line)) ? "output" : null;
      const amount = /data-amount\s*=\s*(['"])(.*?)\1/i.exec(line)?.[2];
      if (!kind || !amount) continue;
      const parsed = JSON.parse(decode(amount)) as { regional?: Record<string, number | null>; global?: number | null };
      Object.assign(rates[kind], parsed.regional ?? {}, parsed.global === undefined ? {} : { global: parsed.global });
    }
    return [{ label: strip(cells[0]), rates }];
  });
}
function claudeRows(html: string): Row[] {
  return [...html.matchAll(/<div\b[^>]*class=(['"])[^'"]*modelCard[^'"]*\1[^>]*>/gi)].map((match) => {
    const card = divBlock(html, match.index!);
    const label = strip(/<h3\b[^>]*>([\s\S]*?)<\/h3>/i.exec(card)?.[1] ?? "");
    const rates = emptyRates();
    for (const [labelText, field] of [["Input", "input"], ["Output", "output"], ["Read", "cachedInput"], ["Write", "cacheWrite"]] as const) {
      const price = new RegExp(`${labelText}[\\s\\S]{0,180}?\\$\\s*([\\d,.]+)\\s*\\/\\s*M(?:Tok|Tokens?)`, "i").exec(card)?.[1];
      if (price) rates[field].global = Number(price.replace(/,/g, ""));
    }
    return { label, rates };
  }).filter((row) => row.label);
}
function candidatePricing(run: BenchmarkRun, rows: Row[], regionFilter: string | null, overrides: Readonly<Record<string, string>>): CandidatePricing {
  const candidate = candidateKey(run), recorded = run.contract.candidate;
  const override = overrides[recorded.model] ?? (recorded.deployment ? overrides[recorded.deployment] : undefined);
  const identities = [recorded.model, recorded.deployment].filter((value): value is string => Boolean(value)).map(modelIdentity);
  const matches = rows.filter((row) => override ? normalize(row.label) === normalize(override) : identities.some((id) => id === modelIdentity(row.label)));
  const sourceUrl = recorded.provider === "openai" ? azureOpenAiPricingUrl : recorded.provider === "anthropic" ? anthropicClaudePricingUrl : null;
  if (!sourceUrl) return { candidate, recorded: { ...recorded, deployment: recorded.deployment ?? null }, sourceUrl, scenarios: [], unavailableReason: `No official pricing source is configured for provider "${recorded.provider}".` };
  if (matches.length === 0) return { candidate, recorded: { ...recorded, deployment: recorded.deployment ?? null }, sourceUrl, scenarios: [], unavailableReason: "No conservative official model-label match. Provide an exact --pricing-model override; no substitute model is guessed." };
  const scenarios = matches.flatMap((row) => {
    const provider = recorded.provider as Provider;
    const regions = provider === "anthropic" ? [null] : [...new Set(meters.flatMap((field) => Object.keys(row.rates[field])))].filter((region) => !regionFilter || region === regionFilter);
    return regions.flatMap((region) => (provider === "anthropic" ? ["5m", "1h"] as CacheTtl[] : [null]).map((ttl) => scenario(provider, row, region, ttl)));
  });
  return { candidate, recorded: { ...recorded, deployment: recorded.deployment ?? null }, sourceUrl, scenarios, unavailableReason: scenarios.length ? null : "No published rate matches the selected region filter; no region is guessed." };
}
function scenario(provider: Provider, row: Row, region: string | null, ttl: CacheTtl | null): PricingScenario {
  const meter = (field: Meter): TokenPrice | null => {
    const value = row.rates[field][region ?? "global"];
    if (value === undefined || value === null || !Number.isFinite(value) || value < 0) return null;
    return { kind: field === "cachedInput" ? "cached-input" : field === "cacheWrite" ? "cache-write" : field, retailPrice: value, region, cacheTtl: field === "cacheWrite" ? ttl : null };
  };
  const cacheWrite = provider === "anthropic" && ttl === "1h" && meter("input") ? { ...meter("input")!, kind: "cache-write" as const, retailPrice: meter("input")!.retailPrice * 2, cacheTtl: ttl } : meter("cacheWrite");
  const input = meter("input"), output = meter("output");
  return { id: `${provider}:${encodeURIComponent(normalize(row.label))}:${region ?? "global"}:${ttl ?? "none"}`, provider, officialModel: row.label, region, cacheTtl: ttl, input, cachedInput: meter("cachedInput"), cacheWrite, output, unavailableReason: input && output ? null : "The official row lacks an input or output rate for this alternative." };
}
function metric(value: Metric<number>): number | null { return value.status === "available" && typeof value.value === "number" && Number.isFinite(value.value) && value.value >= 0 ? value.value : null; }
function unavailable(unavailableReason: string): RunPriceEstimate { return { totalUsd: null, unavailableReason, accountingAssumption: null }; }
function normalize(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function modelIdentity(value: string): string {
  return normalize(value).replace(/\b(claude|global|regional|data zone|standard|provisioned|short context|long context)\b/g, "").replace(/\s+/g, " ").trim();
}
function strip(value: string): string { return decode(value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ")).trim(); }
function decode(value: string): string { return value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"); }
function divBlock(html: string, start: number): string {
  const tags = /<\/?div\b[^>]*>/gi;
  tags.lastIndex = start;
  let depth = 0;
  for (let tag = tags.exec(html); tag; tag = tags.exec(html)) {
    depth += tag[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return html.slice(start, tag.index + tag[0].length);
  }
  throw new TypeError("Malformed official Claude pricing page: unclosed model card.");
}
function isCode(error: unknown, code: string): error is { code: string } { return typeof error === "object" && error !== null && "code" in error && error.code === code; }
function assertSnapshot(value: unknown): asserts value is PricingSnapshot {
  if (!value || typeof value !== "object" || (value as Partial<PricingSnapshot>).schemaVersion !== 1 || !Array.isArray((value as Partial<PricingSnapshot>).candidates)) throw new TypeError("Invalid pricing snapshot.");
}
