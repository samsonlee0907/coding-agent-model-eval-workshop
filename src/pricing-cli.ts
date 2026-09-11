#!/usr/bin/env node
import { resolve } from "node:path";
import { loadBenchmarkRuns } from "./portfolio.js";
import { refreshPricingSnapshot, writePricingSnapshot } from "./pricing.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("Usage: npm run prices:refresh -- --runs <runs> [--region <pricing-page-region>] [--pricing-model recorded=Official Label]");
    return;
  }
  const runsFlag = args.indexOf("--runs");
  if (runsFlag < 0 || !args[runsFlag + 1]) throw new TypeError("--runs requires a directory.");
  const aliases: Record<string, string> = {};
  let region: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--region") region = args[++index];
    if (args[index] === "--pricing-model") {
      const [recorded, ...label] = (args[++index] ?? "").split("=");
      if (!recorded || !label.join("=").trim()) throw new TypeError("--pricing-model requires recorded=Official Label.");
      aliases[recorded] = label.join("=").trim();
    }
  }
  const directory = resolve(args[runsFlag + 1]!);
  const runs = loadBenchmarkRuns(directory);
  if (!runs.length) throw new RangeError(`No completed run.json artifacts found under ${directory}.`);
  const snapshot = await refreshPricingSnapshot(runs, { region, modelOverrides: aliases });
  writePricingSnapshot(snapshot, resolve(directory, "pricing-snapshot.json"));
  console.log(JSON.stringify({ snapshot: resolve(directory, "pricing-snapshot.json"), candidates: snapshot.candidates.length, scenarios: snapshot.candidates.reduce((sum, candidate) => sum + candidate.scenarios.length, 0), sources: snapshot.sources.map((source) => source.pricingUrl) }, null, 2));
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; });
