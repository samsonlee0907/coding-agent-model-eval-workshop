#!/usr/bin/env node
import { resolve } from "node:path";
import { loadBenchmarkRuns } from "./portfolio.js";
import { loadLatestEvaluation, writeHtmlComparisonReport } from "./html-report.js";
import { readFileSync } from "node:fs";
import type { LlmEvaluationResult } from "./types.js";

if (process.argv.includes("--help")) {
  console.log("Usage: npm run report:html -- [--runs <run-directory>] [--output <report.html>] [--evaluation <llm-evaluation.json>]");
} else {
  try {
    const runsDirectory = resolve(argumentValue("--runs") ?? ".benchmark-runs");
    const outputPath = resolve(argumentValue("--output") ?? resolve(runsDirectory, "comparison-report.html"));
    const runs = loadBenchmarkRuns(runsDirectory);
    if (runs.length === 0) {
      throw new RangeError(`No completed run.json artifacts found under ${runsDirectory}.`);
    }
    const evaluationPath = argumentValue("--evaluation");
    const evaluation: LlmEvaluationResult | null = evaluationPath
      ? (JSON.parse(readFileSync(resolve(evaluationPath), "utf8")) as LlmEvaluationResult)
      : loadLatestEvaluation(runsDirectory);
    writeHtmlComparisonReport(runs, outputPath, evaluation);
    console.log(JSON.stringify({
      runs: runs.length,
      evaluation: evaluation ? `${evaluation.judge.model} (${evaluation.scores.length} scored)` : "none",
      report: outputPath,
    }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}

function argumentValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0) {
    return undefined;
  }
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new TypeError(`${flag} requires a value.`);
  }
  return value;
}
