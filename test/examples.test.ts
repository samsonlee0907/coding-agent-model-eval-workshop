import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { prepareCampaign, runCampaign, campaignStatus, reportCampaign } from "../src/campaign.js";
import { atomicJson } from "../src/durable.js";
import { fixtureRun, fixtureRuntime } from "./fixtures/revamp.js";
import { assertCliArguments } from "../src/cli-arguments.js";
import { authSchema, foundryScope, providerSchema } from "../src/auth.js";
import { isolationSchema } from "../src/controlled-worker.js";
import { createQuickstartWorkspace, parseQuickstartOptions } from "../src/quickstart.js";
import { parseEvaluationOptions } from "../src/evaluator-options.js";
import { loadRequestBounds } from "../src/request-policy.js";
import { immutableContractHash } from "../src/contract.js";
import { executionProfile } from "../src/runner.js";
import type { RunContract } from "../src/types.js";

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

test("finite subscription-only Responses diagnostic profile prepares offline and binds the public CLI bounds", () => {
  const root = mkdtempSync(join(tmpdir(), "benchmark-diagnostic-profile-"));
  try {
    const policy = resolve("examples", "request-bounds.responses-diagnostic.example.json");
    const bounds = loadRequestBounds(policy)!;
    assert.deepEqual(bounds, { maxRequests: 10, maxRequestBytes: 1048576, maxTokens: 200000, maxOutputTokens: 2000,
      deadlineMs: 300000, requestsPerMinute: 10, tokensPerMinute: 200000 });
    const spec = JSON.parse(readFileSync(resolve("examples", "custom-campaign", "campaign.json"), "utf8"));
    const originalTask = resolve("examples", "custom-campaign", "text-task.json");
    const task = JSON.parse(readFileSync(originalTask, "utf8"));
    spec.id = "first-run-diagnostic-v1"; spec.tasks = [spec.tasks[0]]; spec.candidates = [spec.candidates[0]];
    spec.candidates[0].candidate.model = "fixture-deployment";
    spec.candidates[0].foundryProvider.auth = { mode: "entra", credential: "azure-cli",
      subscriptionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" };
    spec.requestBounds = bounds; spec.bounds.maxRequests = bounds.maxRequests;
    spec.bounds.maxReservedTokens = bounds.maxTokens; spec.bounds.maxReservationUsd = 4;
    task.contract.candidate = spec.candidates[0].candidate; task.contract.foundryProvider = spec.candidates[0].foundryProvider;
    task.workspacePath = resolve(dirname(originalTask), task.workspacePath); task.requestBounds = bounds;
    const taskPath = join(root, "text-task.json"); writeFileSync(taskPath, JSON.stringify(task));
    spec.tasks[0].config = taskPath; spec.tasks[0].evaluator = resolve("examples", "custom-campaign", "text-evaluator.json");
    const specPath = join(root, "campaign.json"); writeFileSync(specPath, JSON.stringify(spec));
    const prepared = prepareCampaign(specPath, join(root, "state"), fixtureRuntime);
    assert.equal(prepared.spec.tasks.length * prepared.spec.candidates.length * prepared.spec.repeats, 1);
    assert.deepEqual(prepared.tasks[0].config.requestBounds, bounds);
    assert.equal(prepared.tasks[0].config.contract.execution.reasoningEffort, "high");
    const flags = ["--provider", "openai", "--model", "fixture-deployment", "--wire-api", "responses", "--bounds", policy,
      "--auth", "entra", "--credential", "azure-cli", "--subscription-id", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"];
    assert.deepEqual(parseQuickstartOptions([...flags, "--prepare-only", "--task", "Public task"]).requestBounds, bounds);
    assert.deepEqual(parseEvaluationOptions(flags).requestBounds, bounds);
    assert.equal(campaignStatus(join(root, "state")).cells[0].status, "missing");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("new command flag handling rejects unsupported, missing and duplicate options", () => {
  const flags = { "--directory": "value", "--zip": "switch" } as const;
  assert.doesNotThrow(() => assertCliArguments(["--directory", "state", "--zip"], flags));
  assert.throws(() => assertCliArguments(["--typo"], flags), /Unsupported/);
  assert.throws(() => assertCliArguments(["--directory", "--zip"], flags), /requires a value/);
  assert.throws(() => assertCliArguments(["--zip", "--zip"], flags), /Duplicate/);
});

test("documented native-count keyless quickstart prepares and doctor parses without credentials or network", () => {
  const root = mkdtempSync(join(tmpdir(), "bt-native-example-"));
  try {
    const doc = readFileSync(resolve("docs", "CAMPAIGNS_AND_PUBLICATION.md"), "utf8");
    const line = /^npm run quickstart -- (.+--native-token-count.+)$/m.exec(doc);
    assert.ok(line);
    const args = (line[1].match(/'[^']*'|"[^"]*"|\S+/g) ?? []).map(arg => arg === "$subscriptionId"
      ? "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" : arg.replace(/^['"]|['"]$/g, ""));
    args[args.indexOf("--output") + 1] = join(root, "prepared");
    const env = { ...process.env, FOUNDRY_API_KEY: "", FOUNDRY_ENDPOINT: "https://fixture.services.ai.azure.com",
      AZURE_CONFIG_DIR: join(root, "no-real-identity") };
    const help = execFileSync(process.execPath, [resolve("dist", "quickstart-cli.js"), "--help"], { encoding: "utf8", env, timeout: 15000 });
    assert.match(help, /--native-token-count/); assert.match(help, /--anthropic-thinking/);
    execFileSync(process.execPath, [resolve("dist", "quickstart-cli.js"), ...args], { encoding: "utf8", env, timeout: 30000 });
    const path = join(root, "prepared", "benchmark.local.json");
    const config = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(config.contract.foundryProvider.type, "anthropic");
    assert.equal(config.contract.foundryProvider.auth.credential, "azure-cli");
    assert.equal(config.contract.foundryProvider.auth.subscriptionId, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    assert.equal(config.contract.foundryProvider.auth.tenantId, undefined);
    assert.equal(config.contract.foundryProvider.wireApi, undefined);
    assert.equal(config.contract.foundryProvider.anthropicThinking, "adaptive");
    assert.equal(config.contract.foundryProvider.nativeTokenCount.maxAttempts, 4);
    assert.equal(config.contract.execution.reasoningEffort, "high");
    assert.equal(readFileSync(join(root, "prepared", "workspace", "BENCHMARK_TASK.md"), "utf8").trim(), config.contract.task.prompt);
    const checked = JSON.parse(execFileSync(process.execPath, [resolve("dist", "doctor-cli.js"), "--config", path],
      { encoding: "utf8", env, timeout: 30000 }));
    assert.equal(checked.checks.find((check: { stage: string }) => check.stage === "native-token-count").status, "not-verified");
    assert.equal(checked.checks.find((check: { stage: string }) => check.stage === "credential-acquisition").status, "not-verified");
    assert.equal(checked.checks.find((check: { stage: string }) => check.stage === "data-plane-inference").status, "not-verified");
    assert.equal(existsSync(join(root, "prepared", "artifacts")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("public README preserves the five-step flow with parallel bounded GPT and Claude paths", () => {
  const readme = readFileSync(resolve("README.md"), "utf8");
  const guide = readFileSync(resolve("docs", "RUNNING_THE_TOOLKIT.md"), "utf8");
  assert.match(readme, /^# Coding Agent Model Evaluation Workshop\r?\n\r?\nA TypeScript\/npm toolkit/);
  assert.ok(readme.split(/\r?\n/).length < 480, "Keep README an onboarding overview, not the full operator reference.");
  assert.deepEqual([...readme.matchAll(/^## (.+)$/gm)].map((heading) => heading[1].trim()),
    ["Start here", "Reading a generated report", "Task design and supported configuration", "Scope"]);
  assert.deepEqual([...readme.matchAll(/^### ([1-5]\. .+)$/gm)].map((heading) => heading[1].trim()),
    ["1. Install", "2. Configure Foundry", "3. Try one exploratory task",
      "4. Run a controlled cohort", "5. Generate decision artifacts"]);
  for (const marker of ["install", "auth", "bounds", "models", "report"]) {
    for (const shell of ["powershell", "bash"]) {
      assert.equal([...readme.matchAll(new RegExp(`# first-run:${marker}-${shell}\\r?\\n`, "g"))].length, 1);
    }
  }
  const powershellTask = /^\$task = '(.+)'$/m.exec(readme)?.[1];
  const bashTask = /^task='(.+)'$/m.exec(readme)?.[1];
  assert.ok(powershellTask);
  assert.equal(bashTask, powershellTask, "PowerShell and Bash must use the same task.");
  assert.match(readme, /--branch samsonlee0907-staging-benchmark-revamp --single-branch/);
  assert.match(readme, /az account show --subscription \$subscriptionId/);
  assert.match(readme, /az account show --subscription "\$subscription_id"/);
  assert.match(readme, /account\.tenantId -ne \$tenantId/);
  assert.match(readme, /--auth key/);
  assert.match(readme, /maxTokens=20\*\$gptTpm/);
  assert.match(readme, /"maxTokens":\$\(\(20\*claude_tpm\)\)/);
  assert.doesNotMatch(readme, /tokensPerMinute["'=:\s]+200000/);
  assert.match(readme, /Invoke-Item -LiteralPath/);
  assert.match(readme, /open "\$root\/report-v1\/index\.html"/);
  assert.match(readme, /xdg-open "\$root\/report-v1\/index\.html"/);
  assert.match(readme, /paid inference immediately/i);
  assert.match(readme, /Execution completion, task validation, and independent acceptance are separate/);
  assert.match(readme, /Unknown values stay unknown/);
  assert.match(readme, /keyless authentication boundary/);
  assert.match(readme, /campaign workflow/);
  assert.match(readme, /optional judge is a separate paid request/);
  assert.ok(!guide.includes("## Lessons from observed runs, not guarantees"));
  assert.ok(!guide.includes("132,046") && !guide.includes("50,000 TPM"));
  for (const command of ["doctor", "campaign", "quickstart", "bench", "report:html", "portfolio", "prices:refresh", "evaluate"]) {
    assert.ok(guide.includes(`| \`npm run ${command} -- `), `Missing relocated command reference: ${command}`);
  }
  const modelBlocks = ["powershell", "bash"].map((shell) => {
    const block = new RegExp(`# first-run:models-${shell}\\r?\\n([\\s\\S]*?)\\r?\\n\`\`\``).exec(readme);
    assert.ok(block);
    return block[1];
  });
  for (const block of modelBlocks) {
    const commands = [...block.matchAll(/^npm run quickstart -- (.+)$/gm)].map((match) => match[1]);
    assert.equal(commands.length, 2);
    assert.match(commands[0], /--provider openai .*--wire-api responses/);
    assert.match(commands[1], /--provider anthropic/);
    assert.doesNotMatch(commands[1], /--wire-api|--native-token-count|--anthropic-thinking/);
    for (const command of commands) {
      assert.match(command, /--auth entra --credential azure-cli --subscription-id/);
      assert.match(command, /--reasoning-effort high --bounds/);
      assert.doesNotMatch(command, /--tenant-id|--prepare-only|--verify-runtime|--verify-request-fit/);
    }
  }
});

test("onboarding command adapters parse and prepare both shell/provider recipes without credentials or network", () => {
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
  const root = mkdtempSync(join(tmpdir(), "readme-onboarding-"));
  try {
    const blocks = ["powershell", "bash"].map((shell) => {
      const block = new RegExp(`# first-run:models-${shell}\\r?\\n([\\s\\S]*?)\\r?\\n\`\`\``).exec(readme);
      assert.ok(block);
      return block[1];
    });
    const commands = blocks.flatMap((block) =>
      [...block.matchAll(/^npm run quickstart -- (.+)$/gm)].map((match) => match[1]));
    assert.equal(commands.length, 4);
    const tasks = new Set<string>();
    for (const [index, command] of commands.entries()) {
      const args = (command.match(/'[^']*'|"[^"]*"|\S+/g) ?? []).map((token) => {
        const arg = token.replace(/^['"]|['"]$/g, "");
        if (arg === "$task") return "Common inline task";
        if (["$gptDeployment", "$claudeDeployment", "$gpt_deployment", "$claude_deployment"].includes(arg)) {
          return arg.toLowerCase().includes("claude") ? "fixture-claude" : "fixture-gpt";
        }
        if (["$subscriptionId", "$subscription_id"].includes(arg)) {
          return "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
        }
        if (/^\$root[\\/](?:gpt|claude)-bounds\.json$/.test(arg)) {
          return resolve("examples", "request-bounds.example.json");
        }
        if (/^\$root[\\/](?:gpt|claude)$/.test(arg)) return join(root, `prepared-${index}`);
        return arg;
      });
      const options = parseQuickstartOptions(args);
      assert.equal(options.auth?.mode, "entra");
      assert.equal(options.auth.credential, "azure-cli");
      assert.equal(options.auth.subscriptionId, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
      assert.equal(options.auth.tenantId, undefined);
      assert.equal(options.wireApi, options.provider === "anthropic" ? undefined : "responses");
      assert.ok(options.requestBounds);
      tasks.add(options.task);

      const env = { ...process.env, FOUNDRY_API_KEY: "", FOUNDRY_ENDPOINT: "https://fixture.services.ai.azure.com",
        AZURE_CONFIG_DIR: join(root, "no-real-identity") };
      execFileSync(process.execPath, [resolve("dist", "quickstart-cli.js"), ...args, "--prepare-only"],
        { encoding: "utf8", env, timeout: 30000 });
      const prepared = JSON.parse(readFileSync(join(root, `prepared-${index}`, "benchmark.local.json"), "utf8"));
      assert.equal(prepared.contract.foundryProvider.type, options.provider);
      assert.equal(prepared.contract.foundryProvider.wireApi, options.provider === "openai" ? "responses" : undefined);
      assert.equal(existsSync(join(root, `prepared-${index}`, "artifacts")), false);
    }
    assert.deepEqual([...tasks], ["Common inline task"]);

    const evaluateCommands = [...readme.matchAll(/^npm run evaluate -- (.+)$/gm)];
    assert.equal(evaluateCommands.length, 2);
    for (const command of evaluateCommands) {
      const args = (command[1].match(/'[^']*'|"[^"]*"|\S+/g) ?? []).map((token) => {
        const arg = token.replace(/^['"]|['"]$/g, "");
        if (["$runs", "$subscriptionId", "$subscription_id"].includes(arg)) {
          return arg === "$runs" ? root : "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
        }
        if (/^\$root[\\/]judge-bounds\.json$/.test(arg)) return resolve("examples", "request-bounds.example.json");
        if (/^\$root[\\/]judge-review-v1\.json$/.test(arg)) return join(root, "judge-review-v1.json");
        return arg;
      });
      const options = parseEvaluationOptions(args);
      assert.equal(options.provider, "openai");
      assert.equal(options.wireApi, "responses");
      assert.equal(options.auth?.mode, "entra");
      assert.ok(options.requestBounds);
    }

    const bashBlocks = [...readme.matchAll(/```bash\r?\n([\s\S]*?)\r?\n```/g)].map((match) => match[1]).join("\n");
    const bashPath = join(root, "readme-bash.sh");
    writeFileSync(bashPath, `${bashBlocks}\n`, "utf8");
    execFileSync("bash", ["-n", bashPath], { encoding: "utf8", timeout: 15000 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("direct keyless quickstart artifacts flow through portfolio and HTML with strict legacy hash verification", () => {
  const root = mkdtempSync(join(tmpdir(), "direct-quickstart-report-"));
  try {
    const task = "Create a dependency-free sum module and deterministic tests.";
    const subscriptionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const bounds = resolve("examples", "request-bounds.example.json");
    const emitted = ["gpt", "claude"].map((provider, index) => {
      const options = parseQuickstartOptions([
        "--task", task,
        "--provider", provider === "gpt" ? "openai" : "anthropic",
        "--model", provider === "gpt" ? "fixture-gpt" : "fixture-claude",
        ...(provider === "gpt" ? ["--wire-api", "responses"] : []),
        "--auth", "entra", "--credential", "azure-cli", "--subscription-id", subscriptionId,
        "--bounds", bounds, "--output", join(root, provider),
      ]);
      const quickstart = createQuickstartWorkspace(options);
      const config = quickstart.config;
      const identity = {
        type: config.contract.foundryProvider.type,
        endpointFingerprint: (provider === "gpt" ? "a" : "b").repeat(64),
        requestAdaptation: provider === "gpt" ? "openai-null-refusal-sanitizer" as const : "strip-temperature" as const,
        ...(provider === "gpt" ? { wireApi: "responses" as const } : {}),
        auth: config.contract.foundryProvider.auth!,
      };
      const contract: RunContract = {
        contractVersion: 2, task: config.contract.task, candidate: config.contract.candidate,
        execution: config.contract.execution, rounds: config.rounds, runtime: fixtureRuntime,
        foundryProvider: identity, executionProfile: executionProfile(config),
      };
      const run = fixtureRun(`${provider}-direct-${index}`, config, "ungraded");
      run.contract = contract;
      if (provider === "claude") {
        const legacyContract = structuredClone(contract);
        legacyContract.foundryProvider!.auth = {
          ...legacyContract.foundryProvider!.auth!,
          tenantId: undefined,
          clientId: undefined,
        };
        const legacyCanonical = (value: unknown): string => {
          if (Array.isArray(value)) return `[${value.map(legacyCanonical).join(",")}]`;
          if (value !== null && typeof value === "object") {
            return `{${Object.keys(value).sort().map((key) =>
              `${JSON.stringify(key)}:${legacyCanonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
          }
          return JSON.stringify(value);
        };
        run.contractHash = createHash("sha256").update(legacyCanonical(legacyContract)).digest("hex");
      } else {
        run.contractHash = immutableContractHash(contract);
      }
      const persisted = JSON.parse(JSON.stringify(run));
      mkdirSync(persisted.artifacts.directory, { recursive: true });
      writeFileSync(join(persisted.artifacts.directory, "run.json"), `${JSON.stringify(persisted, null, 2)}\n`);
      return persisted;
    });

    execFileSync(process.execPath, [resolve("dist", "portfolio-cli.js"), "--runs", root],
      { encoding: "utf8", timeout: 30000 });
    const report = join(root, "report-v1");
    execFileSync(process.execPath, [resolve("dist", "html-report-cli.js"), "--runs", root, "--bundle", report],
      { encoding: "utf8", timeout: 30000 });
    assert.match(readFileSync(join(root, "model-selection-report.md"), "utf8"), /Retained runs:\*\* 2/);
    assert.match(readFileSync(join(report, "index.html"), "utf8"), /Coding Agent Model Benchmark/);

    const tamperedRoot = join(root, "tampered");
    const tampered = structuredClone(emitted[1]);
    tampered.contract.task.prompt = "Tampered after emission.";
    const tamperedDirectory = join(tamperedRoot, "artifacts", tampered.runId);
    tampered.artifacts.directory = tamperedDirectory;
    mkdirSync(tamperedDirectory, { recursive: true });
    writeFileSync(join(tamperedDirectory, "run.json"), `${JSON.stringify(tampered, null, 2)}\n`);
    assert.throws(() => execFileSync(process.execPath, [resolve("dist", "portfolio-cli.js"), "--runs", tamperedRoot],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000 }), /Contract hash mismatch/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("onboarding navigation resolves existing local documentation and headings", () => {
  const files = ["README.md", join("docs", "KEYLESS_AUTH.md"), join("docs", "ISOLATED_EXECUTION.md"),
    join("docs", "CAMPAIGNS_AND_PUBLICATION.md"), join("docs", "TASK_AUTHORING_GUIDE.md"),
    join("docs", "RUNNING_THE_TOOLKIT.md"),
    join("scenarios", "in-memory-ordering-system", "task.md")];
  let checked = 0;
  for (const file of files) {
    const prose = readFileSync(file, "utf8").replace(/```[\s\S]*?```/g, "");
    for (const link of prose.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
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
