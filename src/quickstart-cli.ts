#!/usr/bin/env node
import { createQuickstartWorkspace, parseQuickstartOptions } from "./quickstart.js";
import { runBenchmark } from "./runner.js";

try {
  const quickstart = createQuickstartWorkspace(parseQuickstartOptions(process.argv.slice(2)));
  const run = await runBenchmark(quickstart.config);
  console.log(JSON.stringify({
    runId: run.runId,
    outcome: run.outcome.class,
    report: run.artifacts.report,
    workspace: quickstart.workspacePath,
    baselineCommitSha: quickstart.baselineCommitSha,
  }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error("Usage: npm run quickstart -- --task \"Build a small app\" --model <model-id> --provider <label> --provider-type <openai|azure|anthropic> [--base-url-env MODEL_BASE_URL] [--api-key-env MODEL_API_KEY] [--source C:\\path\\to\\artifact] [--output C:\\path\\to\\run]");
  process.exitCode = 2;
}
