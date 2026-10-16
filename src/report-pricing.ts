import { createHash } from "node:crypto";
import { evidenceHash, selectReportCells, type EvidenceAttempt, type ReportEvidence } from "./evidence.js";
import type { PricingScenario, PricingSnapshot, TokenPrice } from "./pricing.js";

export type AnthropicPricingAccounting = "sdk-inclusive" | "native-uncached";

export interface ReportPricingEstimate {
  candidate: string;
  provider: string;
  model: string;
  deployment: string | null;
  scenarioId: string | null;
  officialModel: string | null;
  region: string | null;
  cacheTtl: string | null;
  accountingAssumption: string | null;
  selectedAttempts: number;
  allAttempts: number;
  selectedUsd: number | null;
  selectedUnavailableReason: string | null;
  allAttemptsUsd: number | null;
  allAttemptsUnavailableReason: string | null;
}

export interface ReportPricingView {
  status: "available" | "partial" | "unavailable";
  unavailableReason: string | null;
  action: string;
  coverage: {
    candidates: number;
    matchedCandidates: number;
    scenarios: number;
    usableScenarios: number;
  };
  snapshot: null | {
    sha256: string;
    hashBasis: string;
    canonicalObjectSha256: string;
    refreshedAt: string;
    currency: "USD";
    regionFilter: string | null;
    sources: PricingSnapshot["sources"];
  };
  recorded: Array<{
    candidate: string;
    provider: string;
    model: string;
    deployment: string | null;
    selectedAttempts: number;
    allAttempts: number;
    recordedSnapshotHashes: string[];
    recordedScenarioIds: string[];
    recordedAccountingAssumptions: Array<string | null>;
    selectedUsd: number | null;
    selectedUsdUnavailableReason: string | null;
    allAttemptsUsd: number | null;
    allAttemptsUsdUnavailableReason: string | null;
    selectedCostMultiplier: number | null;
    selectedCostMultiplierUnavailableReason: string | null;
    allAttemptsCostMultiplier: number | null;
    allAttemptsCostMultiplierUnavailableReason: string | null;
  }>;
  rates: Array<{
    candidate: string;
    provider: string;
    scenarioId: string;
    officialModel: string;
    region: string | null;
    cacheTtl: string | null;
    inputUsdPerMillion: number | null;
    cachedInputUsdPerMillion: number | null;
    cacheWriteUsdPerMillion: number | null;
    outputUsdPerMillion: number | null;
    unavailableReason: string | null;
  }>;
  estimates: ReportPricingEstimate[];
}

const pricingAction = "Run `npm run prices:refresh -- --runs <runs>` explicitly, review the saved snapshot, then attach it with `report:html --pricing <pricing-snapshot.json>`. Report rendering never fetches prices.";

export function buildReportPricingView(
  evidence: ReportEvidence,
  snapshot: PricingSnapshot | null = null,
  anthropicAccounting?: AnthropicPricingAccounting,
): ReportPricingView {
  const cells = selectReportCells(evidence);
  const selected = new Set(cells.flatMap((cell) => cell.selected ? [cell.selected.id] : []));
  const candidates = evidence.candidates.map((candidate) => {
    const attempts = evidence.attempts.filter((attempt) => attempt.candidate === candidate.id);
    const selectedAttempts = attempts.filter((attempt) => selected.has(attempt.id));
    const recordedUsd = aggregate(selectedAttempts, (attempt) => attempt.metrics.recordedUsd,
      "Selected attempts do not all contain a recorded USD estimate.");
    const allRecordedUsd = aggregate(attempts, (attempt) => attempt.metrics.recordedUsd,
      "Retained attempts do not all contain a recorded USD estimate.");
    const selectedMultiplier = aggregate(selectedAttempts, (attempt) => attempt.metrics.recordedCost,
      "Selected attempts do not all contain an SDK cost multiplier.");
    const allMultiplier = aggregate(attempts, (attempt) => attempt.metrics.recordedCost,
      "Retained attempts do not all contain an SDK cost multiplier.");
    return {
      candidate, attempts, selectedAttempts,
      recorded: {
        candidate: candidate.id, provider: candidate.provider, model: candidate.model, deployment: candidate.deployment ?? null,
        selectedAttempts: selectedAttempts.length, allAttempts: attempts.length,
        recordedSnapshotHashes: unique(attempts.flatMap((attempt) => attempt.pricing ? [attempt.pricing.snapshotHash] : [])),
        recordedScenarioIds: unique(attempts.flatMap((attempt) => attempt.pricing ? [attempt.pricing.scenarioId] : [])),
        recordedAccountingAssumptions: unique(attempts.flatMap((attempt) => attempt.pricing ? [attempt.pricing.accountingAssumption] : [])),
        selectedUsd: recordedUsd.value, selectedUsdUnavailableReason: recordedUsd.reason,
        allAttemptsUsd: allRecordedUsd.value, allAttemptsUsdUnavailableReason: allRecordedUsd.reason,
        selectedCostMultiplier: selectedMultiplier.value, selectedCostMultiplierUnavailableReason: selectedMultiplier.reason,
        allAttemptsCostMultiplier: allMultiplier.value, allAttemptsCostMultiplierUnavailableReason: allMultiplier.reason,
      },
    };
  });
  const rates = snapshot?.candidates.flatMap((candidate) => candidate.scenarios.map((scenario) => ({
    candidate: candidate.candidate, provider: scenario.provider, scenarioId: scenario.id,
    officialModel: scenario.officialModel, region: scenario.region, cacheTtl: scenario.cacheTtl,
    inputUsdPerMillion: rate(scenario.input), cachedInputUsdPerMillion: rate(scenario.cachedInput),
    cacheWriteUsdPerMillion: rate(scenario.cacheWrite), outputUsdPerMillion: rate(scenario.output),
    unavailableReason: scenario.unavailableReason,
  }))) ?? [];
  const estimates: ReportPricingEstimate[] = candidates.flatMap(({ candidate, attempts, selectedAttempts }): ReportPricingEstimate[] => {
    const key = candidateKey(candidate);
    const pricing = snapshot?.candidates.find((entry) => entry.candidate === key);
    const scenarios = pricing?.scenarios ?? [];
    if (!scenarios.length) {
      const reason = snapshot
        ? pricing?.unavailableReason ?? "No saved pricing entry matches this recorded provider/model/deployment identity."
        : "No saved pricing snapshot is attached.";
      return [{
        candidate: candidate.id, provider: candidate.provider, model: candidate.model, deployment: candidate.deployment ?? null,
        scenarioId: null, officialModel: null, region: null, cacheTtl: null, accountingAssumption: null,
        selectedAttempts: selectedAttempts.length, allAttempts: attempts.length,
        selectedUsd: null, selectedUnavailableReason: reason,
        allAttemptsUsd: null, allAttemptsUnavailableReason: reason,
      }];
    }
    return scenarios.map((scenario) => {
      const selectedEstimate = aggregateEstimates(selectedAttempts, scenario, anthropicAccounting);
      const allEstimate = aggregateEstimates(attempts, scenario, anthropicAccounting);
      return {
        candidate: candidate.id, provider: candidate.provider, model: candidate.model, deployment: candidate.deployment ?? null,
        scenarioId: scenario.id, officialModel: scenario.officialModel, region: scenario.region, cacheTtl: scenario.cacheTtl,
        accountingAssumption: scenario.provider === "anthropic"
          ? anthropicAccounting
            ? `${anthropicAccounting}; saved ${scenario.cacheTtl ?? "unspecified"} cache-rate scenario; estimate only, not observed billing.`
            : null
          : "Saved official regional list-price scenario; estimate only, not actual billing.",
        selectedAttempts: selectedAttempts.length, allAttempts: attempts.length,
        selectedUsd: selectedEstimate.value, selectedUnavailableReason: selectedEstimate.reason,
        allAttemptsUsd: allEstimate.value, allAttemptsUnavailableReason: allEstimate.reason,
      };
    });
  });
  const usableScenarioIds = new Set(rates.filter((row) =>
    row.inputUsdPerMillion !== null && row.outputUsdPerMillion !== null && !row.unavailableReason).map((row) => `${row.candidate}\0${row.scenarioId}`));
  const matchedCandidates = new Set(rates.filter((row) =>
    usableScenarioIds.has(`${row.candidate}\0${row.scenarioId}`)).map((row) => row.candidate)).size;
  const coverage = {
    candidates: evidence.candidates.length,
    matchedCandidates,
    scenarios: rates.length,
    usableScenarios: usableScenarioIds.size,
  };
  const status = !snapshot || matchedCandidates === 0
    ? "unavailable"
    : matchedCandidates === evidence.candidates.length
      ? "available"
      : "partial";
  const unavailableReason = !snapshot
    ? "No saved pricing snapshot is attached. Recorded USD and SDK multiplier fields remain separate evidence and may also be unavailable."
    : matchedCandidates === 0
      ? `A saved snapshot is attached, but 0/${evidence.candidates.length} recorded candidate identities have a matched usable input/output pricing scenario.`
      : matchedCandidates < evidence.candidates.length
        ? `A saved snapshot is attached, but only ${matchedCandidates}/${evidence.candidates.length} recorded candidate identities have a matched usable input/output pricing scenario.`
        : null;
  const snapshotBytes = snapshot ? `${JSON.stringify(snapshot, null, 2)}\n` : null;
  return {
    status,
    unavailableReason,
    action: pricingAction,
    coverage,
    snapshot: snapshot ? {
      sha256: createHash("sha256").update(snapshotBytes!).digest("hex"),
      hashBasis: "SHA-256 of the UTF-8 bytes emitted as pricing-snapshot.json: JSON.stringify(snapshot, null, 2) plus one LF.",
      canonicalObjectSha256: evidenceHash(snapshot),
      refreshedAt: snapshot.refreshedAt, currency: snapshot.currency,
      regionFilter: snapshot.regionFilter, sources: snapshot.sources,
    } : null,
    recorded: candidates.map((entry) => entry.recorded),
    rates,
    estimates,
  };
}

export function pricingEstimateRows(view: ReportPricingView): Array<Record<string, unknown>> {
  return view.estimates.map((estimate) => ({
    candidate: estimate.candidate, provider: estimate.provider, model: estimate.model, deployment: estimate.deployment,
    scenarioId: estimate.scenarioId, officialModel: estimate.officialModel, region: estimate.region, cacheTtl: estimate.cacheTtl,
    accountingAssumption: estimate.accountingAssumption, selectedAttempts: estimate.selectedAttempts,
    allAttempts: estimate.allAttempts, selectedUsd: estimate.selectedUsd,
    selectedUnavailableReason: estimate.selectedUnavailableReason, allAttemptsUsd: estimate.allAttemptsUsd,
    allAttemptsUnavailableReason: estimate.allAttemptsUnavailableReason,
  }));
}

function aggregate(
  attempts: readonly EvidenceAttempt[],
  select: (attempt: EvidenceAttempt) => number | null,
  incompleteReason: string,
): { value: number | null; reason: string | null } {
  if (!attempts.length) return { value: null, reason: "No recorded attempts are available for this scope." };
  const values = attempts.map(select);
  if (values.some((value) => value === null)) return { value: null, reason: incompleteReason };
  return { value: values.reduce<number>((sum, value) => sum + value!, 0), reason: null };
}

function aggregateEstimates(
  attempts: readonly EvidenceAttempt[],
  scenario: PricingScenario,
  anthropicAccounting?: AnthropicPricingAccounting,
): { value: number | null; reason: string | null } {
  if (!attempts.length) return { value: null, reason: "No recorded attempts are available for this scope." };
  const estimates = attempts.map((attempt) => estimateAttempt(attempt, scenario, anthropicAccounting));
  const unavailable = estimates.find((estimate) => estimate.value === null);
  if (unavailable) return unavailable;
  return { value: estimates.reduce((sum, estimate) => sum + estimate.value!, 0), reason: null };
}

function estimateAttempt(
  attempt: EvidenceAttempt,
  scenario: PricingScenario,
  anthropicAccounting?: AnthropicPricingAccounting,
): { value: number | null; reason: string | null } {
  if (attempt.accounting.nativeTokenCount?.requests) return unavailable(
    "Native token-count request fees are unknown; an inference-token subtotal is not a complete whole-run price.",
  );
  if (attempt.accounting.ambiguousRequests && !attempt.accounting.providerTerminals) return unavailable(
    "Ambiguous dispatch lacks complete provider metering; missing historical usage cannot be reconstructed.",
  );
  if (attempt.accounting.providerTerminals
      && attempt.accounting.providerTerminals.filter((entry) => entry.terminal.usageStatus === "reported").length
        + (attempt.accounting.rejectedRequests ?? 0) < (attempt.metrics.physicalRequests ?? 0)) {
    return unavailable("Some dispatched physical requests lack complete provider token usage; known subtotals cannot price unknown spend.");
  }
  if (scenario.unavailableReason || !scenario.input || !scenario.output) return unavailable(
    scenario.unavailableReason ?? "The selected scenario lacks input or output rates.",
  );
  if (scenario.provider === "anthropic" && !anthropicAccounting) return unavailable(
    "Claude input accounting is unverified; regenerate with explicit `--anthropic-accounting sdk-inclusive|native-uncached`.",
  );
  const input = attempt.metrics.inputTokens;
  const reads = attempt.metrics.cacheReadTokens ?? null;
  const writes = attempt.metrics.cacheWriteTokens ?? null;
  const output = attempt.metrics.outputTokens;
  if ([input, reads, writes, output].some((value) => value === null)) return unavailable(
    "Complete captured input, cache-read, cache-write, and output telemetry is required.",
  );
  const inclusive = scenario.provider === "openai" || anthropicAccounting === "sdk-inclusive";
  const fresh = inclusive ? input! - reads! - writes! : input!;
  if (fresh < 0) return unavailable("Cache reads plus writes exceed inclusive input; fresh input cannot be negative.");
  if ((reads! > 0 && !scenario.cachedInput) || (writes! > 0 && !scenario.cacheWrite)) return unavailable(
    "The selected scenario lacks a rate for a used cache meter.",
  );
  const price = (tokens: number, meter: TokenPrice | null) => tokens === 0 ? 0 : tokens * meter!.retailPrice / 1_000_000;
  return {
    value: price(fresh, scenario.input) + price(reads!, scenario.cachedInput) + price(writes!, scenario.cacheWrite) + price(output!, scenario.output),
    reason: null,
  };
}

function unavailable(reason: string): { value: null; reason: string } {
  return { value: null, reason };
}

function rate(value: TokenPrice | null): number | null {
  return value?.retailPrice ?? null;
}

function candidateKey(candidate: ReportEvidence["candidates"][number]): string {
  return `${candidate.provider}/${candidate.model}${candidate.deployment ? `/${candidate.deployment}` : ""}`;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
