#!/usr/bin/env node
import { basename, dirname } from "node:path";
import { evaluateBenchmarkRuns, writeLlmEvaluation } from "./evaluator.js";
import { parseEvaluationOptions } from "./evaluator-options.js";
import { loadBenchmarkRuns } from "./portfolio.js";

if (process.argv.includes("--help")) {
  console.log("Usage: npm run evaluate -- --runs <run-directory> --provider <openai|anthropic> --model <judge-deployment> [--reasoning-effort high] [--timeout-ms 120000] [--output <evaluation.json>]");
} else {
  try {
    const options = parseEvaluationOptions(process.argv.slice(2));
    const runs = loadBenchmarkRuns(options.runsDirectory);
    if (runs.length === 0) {
      throw new RangeError(`No completed run.json artifacts found under ${options.runsDirectory}.`);
    }
    const evaluation = await evaluateBenchmarkRuns(runs, {
      provider: { type: options.provider },
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      timeoutMs: options.timeoutMs,
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
