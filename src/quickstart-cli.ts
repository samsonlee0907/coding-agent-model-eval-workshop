#!/usr/bin/env node
import { createQuickstartWorkspace, parseQuickstartOptions } from "./quickstart.js";
import { createTerminalProgressReporter } from "./progress.js";
import { runBenchmark } from "./runner.js";

const usage = "Usage: npm run quickstart -- --task <prompt> | --task-file <file> --model <deployment> --provider <openai|anthropic>\n" +
  "  --bounds <request-bounds.json> [--prepare-only] [--source <starter>] [--output <new-folder>]\n" +
  "  [--wire-api completions|responses] [--reasoning-effort high]\n" +
  "  [--auth key|entra] [--credential azure-cli|managed-identity|workload-identity]\n" +
  "  [--tenant-id <uuid>] [--subscription-id <uuid>] [--client-id <uuid>]\n" +
  "Azure CLI: --tenant-id and --subscription-id are mutually exclusive.\n" +
  "Trusted-local only. Without --prepare-only this sends paid inference immediately; explicit bounds are required.";
if (process.argv.includes("--help")) {
  console.log(usage);
} else {
  try {
    const options = parseQuickstartOptions(process.argv.slice(2));
    if (!options.requestBounds) throw new TypeError("Quickstart CLI requires --bounds <request-bounds.json>. Copy examples/request-bounds.example.json and review limits before execution.");
    const quickstart = createQuickstartWorkspace(options);
    if (options.prepareOnly) console.log(JSON.stringify({ config: quickstart.configPath, workspace: quickstart.workspacePath, inference: "not-dispatched" }, null, 2));
    else {
      const run = await runBenchmark(quickstart.config, { onEvent: createTerminalProgressReporter() });
      console.log(JSON.stringify({
        runId: run.runId, outcome: run.outcome.class, executionStatus: run.executionStatus,
        requestAccounting: run.requestAccounting, report: run.artifacts.report,
        workspace: quickstart.workspacePath, baselineCommitSha: quickstart.baselineCommitSha,
      }, null, 2));
      if (run.executionStatus !== "completed") process.exitCode = 2;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage);
    process.exitCode = 2;
  }
}
