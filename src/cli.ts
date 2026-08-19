#!/usr/bin/env node
import { resolve } from "node:path";
import { createTerminalProgressReporter } from "./progress.js";
import { loadBenchmarkConfig, runBenchmark } from "./runner.js";

const configFlag = process.argv.indexOf("--config");
if (configFlag < 0 || !process.argv[configFlag + 1]) {
  console.error("Usage: npm run bench -- --config <benchmark-config.json>");
  process.exitCode = 2;
} else {
  const run = await runBenchmark(
    loadBenchmarkConfig(resolve(process.argv[configFlag + 1])),
    { onEvent: createTerminalProgressReporter() },
  );
  console.log(JSON.stringify({
    runId: run.runId,
    outcome: run.outcome.class,
    report: run.artifacts.report,
  }, null, 2));
}
