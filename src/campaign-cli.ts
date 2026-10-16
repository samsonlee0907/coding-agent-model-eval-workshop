#!/usr/bin/env node
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { prepareCampaign, runCampaign, campaignStatus, reportCampaign, cleanupCampaignWorker } from "./campaign.js";
import { assertCliArguments } from "./cli-arguments.js";

const argv = process.argv.slice(2);
function value(flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const result = argv[index + 1];
  if (!result || result.startsWith("--")) throw new TypeError(`${flag} requires a value.`);
  return result;
}
function required(flag: string): string {
  const result = value(flag);
  if (!result) throw new TypeError(`${flag} is required.`);
  return resolve(result);
}
try {
  if (argv.includes("--help")) console.log(
    "Usage: npm run campaign -- prepare --spec <campaign.json> --directory <new-state-folder>\n" +
    "       npm run campaign -- run|resume --directory <state-folder> --allow-paid [--recover-lock] [--recover-rejected]\n" +
    "       npm run campaign -- status --directory <state-folder>\n" +
    "       npm run campaign -- report --directory <state-folder> --output <new-report-folder> [--zip] [--publication <manifest.json>]\n" +
    "       npm run campaign -- cleanup --directory <state-folder> --record <owned-worker.json> [--recover-lock]\n" +
    "No implicit inference recovery after ambiguous dispatch. Resume finalizes retained outputs and skips completed content FAILs.",
  );
  else {
    const common = { "--directory": "value" } as const;
    const flags: Record<string, Record<string, "value" | "switch">> = {
      prepare: { ...common, "--spec": "value" }, status: common,
      run: { ...common, "--allow-paid": "switch", "--recover-lock": "switch", "--recover-rejected": "switch" },
      resume: { ...common, "--allow-paid": "switch", "--recover-lock": "switch", "--recover-rejected": "switch" },
      report: { ...common, "--output": "value", "--zip": "switch", "--publication": "value" },
      cleanup: { ...common, "--record": "value", "--recover-lock": "switch" },
    };
    if (!flags[argv[0]]) throw new TypeError("Choose prepare, run, status, resume, report or cleanup. See --help.");
    assertCliArguments(argv.slice(1), flags[argv[0]]);
    const directory = required("--directory");
    switch (argv[0]) {
      case "prepare": {
        const prepared = prepareCampaign(required("--spec"), directory);
        console.log(JSON.stringify({ campaign: prepared.spec.id, preparedHash: prepared.hash, directory })); break;
      }
      case "run": case "resume": {
        const evidence = await runCampaign(directory, { allowPaid: argv.includes("--allow-paid"),
          recoverLock: argv.includes("--recover-lock"), recoverRejected: argv.includes("--recover-rejected") });
        console.log(JSON.stringify({ campaign: evidence.campaignId, attempts: evidence.attempts.length })); break;
      }
      case "status": console.log(JSON.stringify(campaignStatus(directory), null, 2)); break;
      case "cleanup":
        await cleanupCampaignWorker(directory, required("--record"), argv.includes("--recover-lock"));
        console.log(JSON.stringify({ cleanup: "completed", record: required("--record") })); break;
      case "report": {
        const publication = value("--publication");
        console.log(JSON.stringify({ report: reportCampaign(directory, required("--output"),
          { zip: argv.includes("--zip"), publication: publication ? JSON.parse(readFileSync(resolve(publication), "utf8")) : undefined }) })); break;
      }
      default: throw new TypeError("Choose prepare, run, status, resume or report. See --help.");
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2;
}
