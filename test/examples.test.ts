import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { prepareCampaign, runCampaign, campaignStatus, reportCampaign } from "../src/campaign.js";
import { atomicJson } from "../src/durable.js";
import { fixtureRun, fixtureRuntime } from "./fixtures/revamp.js";
import { assertCliArguments } from "../src/cli-arguments.js";
import { authSchema, foundryScope, providerSchema } from "../src/auth.js";
import { isolationSchema } from "../src/controlled-worker.js";
import { parseQuickstartOptions } from "../src/quickstart.js";
import { parseEvaluationOptions } from "../src/evaluator-options.js";

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

test("onboarding auth/isolation fragments and immediate-run commands match implemented parsers", () => {
  const readme = readFileSync(resolve("README.md"), "utf8");
  const keyless = readFileSync(resolve("docs", "KEYLESS_AUTH.md"), "utf8");
  const isolated = readFileSync(resolve("docs", "ISOLATED_EXECUTION.md"), "utf8");
  assert.ok(keyless.includes(foundryScope));
  const provider = /```json\r?\n([\s\S]*?)\r?\n[ \t]*```/.exec(keyless);
  assert.ok(provider);
  assert.equal(providerSchema.parse(JSON.parse(provider[1])).auth?.mode, "entra");
  for (const match of keyless.matchAll(/`(\{"mode":"entra"[^`]+\})`/g)) {
    assert.doesNotThrow(() => authSchema.parse(JSON.parse(match[1].replace(/<(?:client|tenant)-uuid>/g, "11111111-2222-4333-8444-555555555555"))));
  }
  const policy = /```json\r?\n([\s\S]*?)\r?\n[ \t]*```/.exec(isolated);
  assert.ok(policy);
  const config = JSON.parse(policy[1]);
  config.isolation.image = `owner/fixture@sha256:${"a".repeat(64)}`;
  assert.equal(isolationSchema.parse(config.isolation).mode, "container");
  const commands = [...(readme + keyless).matchAll(/^npm run (quickstart|evaluate) -- (.+)$/gm)];
  assert.equal(commands.length, 3);
  for (const command of commands) {
    const args = (command[2].match(/'[^']*'|"[^"]*"|\S+/g) ?? []).map((arg) => {
      if (arg === "$deployment") return "fixture-deployment";
      if (arg === "$tenantId") return "11111111-2222-4333-8444-555555555555";
      return arg.replace(/^['"]|['"]$/g, "");
    });

    const options = command[1] === "quickstart" ? parseQuickstartOptions(args) : parseEvaluationOptions(args);
    assert.equal(options.auth?.mode, "entra");
    assert.equal(options.wireApi, "responses");
  }
});

test("onboarding navigation resolves existing local documentation and headings", () => {
  const files = ["README.md", join("docs", "KEYLESS_AUTH.md"), join("docs", "ISOLATED_EXECUTION.md"),
    join("docs", "CAMPAIGNS_AND_PUBLICATION.md"), join("docs", "TASK_AUTHORING_GUIDE.md"),
    join("scenarios", "in-memory-ordering-system", "task.md")];
  let checked = 0;
  for (const file of files) {
    for (const link of readFileSync(file, "utf8").matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = link[1];
      if (/^https?:/.test(target)) continue;
      const [path, anchor] = target.split("#");
      const actual = path ? resolve(dirname(file), path.replaceAll("/", sep)) : resolve(file);
      assert.ok(existsSync(actual), `${file}: missing ${target}`);
      if (anchor) {
        const headings = [...readFileSync(actual, "utf8").matchAll(/^#{1,6} (.+)$/gm)]
          .map((heading) => heading[1].toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, "").replaceAll(" ", "-"));
        assert.ok(headings.includes(anchor), `${file}: missing anchor ${target}`);
      }
      checked++;
    }
  }
  assert.ok(checked > 40);
});

test("documented isolation probe retains owned cleanup and validates before export without real Docker", async () => {
  const guide = readFileSync(resolve("docs", "ISOLATED_EXECUTION.md"), "utf8");
  const match = /# isolation:probe\r?\n@'\r?\n([\s\S]*?)\r?\n'@/.exec(guide);
  assert.ok(match);
  const script = match[1].replace(/^import .+;\r?\n/gm, "");
  const probe = new Function("readFileSync", "dirname", "join", "resolve", "ControlledWorker", "collectSnapshot", "process", "console",
    `return (async () => { ${script} })();`);
  const policy = { mode: "container", image: `owner/fixture@sha256:${"a".repeat(64)}`, memoryMb: 1024, cpus: 1,
    maxFiles: 100, maxBytes: 1048576, commandTimeoutMs: 60000 };
  for (const valid of [true, false]) {
    const calls: string[] = [];
    const worker = {
      async validate(command: string) {
        assert.match(command, /process\.getuid\(\)!==1000/); calls.push("validate");
        return { exitCode: valid ? 0 : 1, timedOut: false, errorMessage: null };
      },
      async snapshot(destination: string) { assert.ok(destination.endsWith("isolation-smoke-output")); calls.push("snapshot"); return "fixture-hash"; },
      async dispose() { calls.push("dispose"); },
    };
    const execution = probe(() => JSON.stringify({ isolation: policy, workspacePath: "text-input" }),
      () => "fixture", join, resolve,
      { async create(actual: unknown, _files: unknown, record: string) {
        assert.deepEqual(actual, policy); assert.ok(record.endsWith("isolation-smoke-worker.json")); calls.push("create"); return worker;
      } }, () => [], { argv: ["node", "-", "fixture-task.json", "fixture-work"] },
      { log(message: string) { assert.equal(JSON.parse(message).isolatedExportHash, "fixture-hash"); } });
    if (valid) {
      await execution;
      assert.deepEqual(calls, ["create", "validate", "snapshot", "dispose"]);
    } else {
      await assert.rejects(execution, /Nonroot validation failed/);
      assert.deepEqual(calls, ["create", "validate", "dispose"]);
    }
  }
});
