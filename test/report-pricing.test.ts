import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { evidenceFromRuns } from "../src/evidence.js";
import { buildReportPricingView } from "../src/report-pricing.js";
import { anthropicClaudePricingUrl, anthropicExtendedCachePricingUrl, azureOpenAiPricingUrl, foundryClaudeBillingUrl, type PricingSnapshot } from "../src/pricing.js";
import { immutableContractHash } from "../src/contract.js";
import { fixtureConfig, fixtureRun } from "./fixtures/revamp.js";

test("Anthropic what-if totals require an explicit accounting assumption", () => {
  const config = fixtureConfig("workspace", "task", "claude");
  config.contract.candidate.provider = "anthropic";
  config.contract.foundryProvider.type = "anthropic";
  config.contract.foundryProvider.wireApi = "messages";
  const run = fixtureRun("claude-run", config);
  run.contract.candidate.provider = "anthropic";
  run.contract.foundryProvider!.type = "anthropic";
  run.contract.foundryProvider!.wireApi = "messages";
  run.contractHash = immutableContractHash(run.contract);
  const evidence = evidenceFromRuns([run]);
  const pricing: PricingSnapshot = {
    schemaVersion: 1, refreshedAt: "2026-10-16T00:00:00.000Z", regionFilter: null, currency: "USD",
    sources: [{
      provider: "anthropic", pricingUrl: anthropicClaudePricingUrl, documentationUrl: foundryClaudeBillingUrl,
      extendedCachePricingUrl: anthropicExtendedCachePricingUrl, contentHash: "b".repeat(64),
    }],
    candidates: [{
      candidate: "anthropic/claude/claude", recorded: { provider: "anthropic", model: "claude", deployment: "claude" },
      sourceUrl: anthropicClaudePricingUrl, unavailableReason: null,
      scenarios: [{
        id: "claude-5m", provider: "anthropic", officialModel: "Claude", region: null, cacheTtl: "5m",
        input: { kind: "input", retailPrice: 1, region: null, cacheTtl: "5m" },
        cachedInput: { kind: "cached-input", retailPrice: .1, region: null, cacheTtl: "5m" },
        cacheWrite: { kind: "cache-write", retailPrice: 1.25, region: null, cacheTtl: "5m" },
        output: { kind: "output", retailPrice: 2, region: null, cacheTtl: "5m" },
        unavailableReason: null,
      }],
    }],
  };
  const unknown = buildReportPricingView(evidence, pricing);
  assert.equal(unknown.estimates[0].selectedUsd, null);
  assert.match(unknown.estimates[0].selectedUnavailableReason ?? "", /explicit `--anthropic-accounting/);
  const explicit = buildReportPricingView(evidence, pricing, "sdk-inclusive");
  assert.equal(explicit.estimates[0].selectedUsd, .00016);
  assert.match(explicit.estimates[0].accountingAssumption ?? "", /sdk-inclusive/);
});

test("native count fees keep whole-run what-if pricing unavailable", () => {
  const run = fixtureRun("native-count");
  run.requestAccounting!.nativeTokenCount = {
    schemaVersion: 1, requests: 1, retries: 0, completed: 1, retryWaitMs: 0, fees: "unknown",
    attempts: [{
      request: 1, attempt: 1, inferenceBodyHash: "d".repeat(64), countBodyHash: "e".repeat(64),
      status: "completed", httpStatus: 200, code: null, requestIds: {}, responseBodyHash: "f".repeat(64),
      responseBodyTruncated: false, inputTokens: 100, retryAfterMs: null,
    }],
  };
  const evidence = evidenceFromRuns([run]);
  const pricing: PricingSnapshot = {
    schemaVersion: 1, refreshedAt: "2026-10-16T00:00:00.000Z", regionFilter: null, currency: "USD",
    sources: [{ provider: "openai", pricingUrl: azureOpenAiPricingUrl, documentationUrl: null,
      extendedCachePricingUrl: null, contentHash: "c".repeat(64) }],
    candidates: [{
      candidate: "openai/candidate-a/candidate-a",
      recorded: { provider: "openai", model: "candidate-a", deployment: "candidate-a" },
      sourceUrl: azureOpenAiPricingUrl, unavailableReason: null,
      scenarios: [{
        id: "candidate-a", provider: "openai", officialModel: "Candidate A", region: null, cacheTtl: null,
        input: { kind: "input", retailPrice: 1, region: null, cacheTtl: null },
        cachedInput: null, cacheWrite: null,
        output: { kind: "output", retailPrice: 2, region: null, cacheTtl: null },
        unavailableReason: null,
      }],
    }],
  };
  const unavailable = buildReportPricingView(evidence, pricing);
  assert.equal(unavailable.status, "available");
  assert.equal(unavailable.estimates[0].selectedUsd, null);
  assert.match(unavailable.estimates[0].selectedUnavailableReason ?? "", /Native token-count request fees are unknown/);
});

test("an attached snapshot with zero usable matches remains UNKNOWN and reports its exported byte hash", () => {
  const evidence = evidenceFromRuns([fixtureRun("unmatched")]);
  const pricing: PricingSnapshot = {
    schemaVersion: 1, refreshedAt: "2026-10-16T00:00:00.000Z", regionFilter: null, currency: "USD",
    sources: [{ provider: "openai", pricingUrl: azureOpenAiPricingUrl, documentationUrl: null,
      extendedCachePricingUrl: null, contentHash: "1".repeat(64) }],
    candidates: [{
      candidate: "openai/candidate-a/candidate-a",
      recorded: { provider: "openai", model: "candidate-a", deployment: "candidate-a" },
      sourceUrl: azureOpenAiPricingUrl, scenarios: [],
      unavailableReason: "No conservative official model-label match.",
    }],
  };
  const view = buildReportPricingView(evidence, pricing);
  assert.equal(view.status, "unavailable");
  assert.deepEqual(view.coverage, { candidates: 1, matchedCandidates: 0, scenarios: 0, usableScenarios: 0 });
  assert.match(view.unavailableReason ?? "", /snapshot is attached.*0\/1/);
  assert.equal(view.snapshot?.sha256,
    createHash("sha256").update(`${JSON.stringify(pricing, null, 2)}\n`).digest("hex"));
  assert.match(view.snapshot?.hashBasis ?? "", /UTF-8 bytes emitted as pricing-snapshot\.json/);
});
