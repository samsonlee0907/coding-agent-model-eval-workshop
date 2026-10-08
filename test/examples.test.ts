import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prepareCampaign, runCampaign, campaignStatus, reportCampaign } from "../src/campaign.js";
import { atomicJson } from "../src/durable.js";
import { fixtureRun, fixtureRuntime } from "./fixtures/revamp.js";
import { assertCliArguments } from "../src/cli-arguments.js";

test("documented custom campaign prepares, grades varied categories, resumes and publishes without inference", async () => {
  const root = mkdtempSync(join(tmpdir(), "benchmark-example-"));
  try {
    const directory = join(root, "campaign");
    prepareCampaign(resolve("examples", "custom-campaign", "campaign.json"), directory, fixtureRuntime);
    let calls = 0;
    const evidence = await runCampaign(directory, {
      allowPaid: true, runtime: fixtureRuntime, freeMemory: () => 1024 * 1024 * 1024,
      run: async (config, options) => {
        calls++;
        if (config.contract.task.id === "text-result") writeFileSync(join(config.workspacePath, "result.txt"), "OK\n");
        else writeFileSync(join(config.workspacePath, "answer.json"),
          config.contract.candidate.model.endsWith("_B") ? '{"sum":"16"}' : '{ "extra": true, "sum": 16 }');
        const run = fixtureRun(options.runId!, config, "ungraded");
        atomicJson(join(run.artifacts.directory, "run.json"), run); return run;
      },
    });
    assert.equal(calls, 4);
    assert.deepEqual(campaignStatus(directory).cells.map((c) => c.status), ["pass", "pass", "pass", "fail"]);
    assert.ok(evidence.attempts.every((a) => a.policyHash && a.workspaceHash && a.reservation?.requests === 10));
    assert.ok(!JSON.stringify(evidence).includes("fs=require"));
    await runCampaign(directory, { allowPaid: true, runtime: fixtureRuntime, run: async () => { throw new Error("Paid inference must not replay."); } });
    const report = reportCampaign(directory, join(root, "report"), { zip: true });
    assert.match(readFileSync(report, "utf8"), /Coding Agent Model Benchmark/);
    assert.equal(JSON.parse(readFileSync(join(root, "report", "selected-results.json"), "utf8")).length, 4);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("new command flag handling rejects unsupported, missing and duplicate options", () => {
  const flags = { "--directory": "value", "--zip": "switch" } as const;
  assert.doesNotThrow(() => assertCliArguments(["--directory", "state", "--zip"], flags));
  assert.throws(() => assertCliArguments(["--typo"], flags), /Unsupported/);
  assert.throws(() => assertCliArguments(["--directory", "--zip"], flags), /requires a value/);
  assert.throws(() => assertCliArguments(["--zip", "--zip"], flags), /Duplicate/);
});
