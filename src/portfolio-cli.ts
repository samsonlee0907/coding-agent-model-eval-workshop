#!/usr/bin/env node
import { join, resolve } from "node:path";
import { loadBenchmarkRuns, writeModelSelectionReport } from "./portfolio.js";

const runsDirectory = resolve(argumentValue("--runs") ?? ".benchmark-runs");
const outputPath = resolve(argumentValue("--output") ?? join(runsDirectory, "model-selection-report.md"));
const runs = loadBenchmarkRuns(runsDirectory);

if (runs.length === 0) {
  console.error(`No completed run.json artifacts found under ${runsDirectory}.`);
  process.exitCode = 2;
} else {
  writeModelSelectionReport(runs, outputPath);
  console.log(JSON.stringify({ runs: runs.length, report: outputPath }, null, 2));
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
