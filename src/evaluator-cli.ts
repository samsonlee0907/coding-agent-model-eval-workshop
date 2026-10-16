#!/usr/bin/env node
import { basename, dirname, join } from "node:path";
import { evaluateBenchmarkRuns, FoundryJudgeInvoker, writeLlmEvaluation } from "./evaluator.js";
import { atomicJson } from "./durable.js";
import { evidenceHash } from "./evidence.js";
import { parseEvaluationOptions } from "./evaluator-options.js";
import { loadBenchmarkRuns } from "./portfolio.js";

if (process.argv.includes("--help")) {
  console.log("Usage: npm run evaluate -- --runs <run-directory> --provider <openai|anthropic> --model <judge-deployment> --bounds <request-bounds.json>\n" +
    "  [--wire-api completions|responses] [--auth key|entra] [--credential azure-cli|managed-identity|workload-identity]\n" +
    "  [--tenant-id <uuid>] [--subscription-id <uuid>] [--client-id <uuid>]\n" +
    "Azure CLI: --tenant-id and --subscription-id are mutually exclusive.\n" +
    "  [--reasoning-effort high] [--timeout-ms 120000] [--output <evaluation.json>]\nPaid inference immediately; explicit request/token/output/pacing/deadline bounds are required.");
} else {
  try {
    const options = parseEvaluationOptions(process.argv.slice(2));
    if (!options.requestBounds) throw new TypeError("Judge CLI requires --bounds <request-bounds.json>. Review examples/request-bounds.example.json before a paid evaluation.");
    const runs = loadBenchmarkRuns(options.runsDirectory);
    if (runs.length === 0) {
      throw new RangeError(`No completed run.json artifacts found under ${options.runsDirectory}.`);
    }
    const config = {
      provider: { type: options.provider, auth: options.auth, wireApi: options.wireApi },
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      timeoutMs: options.timeoutMs,
      requestBounds: options.requestBounds,
    };
    const invoker = new FoundryJudgeInvoker();
    const evaluation = await evaluateBenchmarkRuns(runs, config, invoker).catch((error: unknown) => {
      const failurePath = join(options.outputPath ? dirname(options.outputPath) : options.runsDirectory,
        `llm-evaluation-failure-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
      atomicJson(failurePath, {
        schemaVersion: 1, evaluationStatus: "failed", scores: null,
        requestBoundsHash: evidenceHash(options.requestBounds),
        requestAccounting: invoker.requestAccounting ?? null,
        providerDiagnostics: invoker.providerDiagnostics,
        error: "Judge execution or score parsing failed; no scores published.",
      });
      console.error(`No judge scores published. Retained failure accounting: ${failurePath}`);
      throw error;
    });
    const artifact = writeLlmEvaluation(
      evaluation,
      options.outputPath ? dirname(options.outputPath) : options.runsDirectory,
      options.outputPath ? basename(options.outputPath) : undefined,
    );
    console.log(JSON.stringify({
      evaluatedRuns: evaluation.evaluatedRunIds.length,
      judge: `${options.provider}/${options.model}`,
      output: artifact.path,
    }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
