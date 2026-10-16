import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

test("real pinned AzureCliCredential subprocess and public doctor accept exclusive selectors without changing defaults or leaking tokens", () => {
  const root = mkdtempSync(join(tmpdir(), "benchmark-fake-az-"));
  const tenantId = "11111111-2222-4333-8444-555555555555", subscriptionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  try {
    const bin = join(root, "bin"); cpSync(resolve("test", "fixtures", "azure-cli"), bin, { recursive: true });
    if (process.platform !== "win32") chmodSync(join(bin, "az"), 0o755);
    const state = join(root, "cli-state"); mkdirSync(state);
    const defaults = join(state, "azureProfile.json"), initialDefaults = '{"defaultSubscription":"unchanged-fixture"}';
    writeFileSync(defaults, initialDefaults);
    const log = join(root, "commands.ndjson"), env = { ...process.env };
    const currentPath = Object.entries(env).find(([name]) => name.toLowerCase() === "path")?.[1] ?? "";
    for (const name of Object.keys(env)) if (name.toLowerCase() === "path") delete env[name];
    Object.assign(env, { PATH: `${bin}${delimiter}${currentPath}`, AZURE_CONFIG_DIR: state,
      BENCHMARK_FAKE_AZ_NODE: process.execPath, BENCHMARK_FAKE_AZ_LOG: log,
      FOUNDRY_ENDPOINT: "https://fixture.services.ai.azure.com", FOUNDRY_API_KEY: "" });
    const authModule = pathToFileURL(resolve("dist", "auth.js")).href;
    const identityModule = pathToFileURL(resolve("node_modules", "@azure", "identity", "dist", "esm", "index.js")).href;
    const code = `
      import assert from "node:assert/strict";
      import { AzureCliCredential } from ${JSON.stringify(identityModule)};
      import { bearerTokenProvider, createCredential, foundryScope } from ${JSON.stringify(authModule)};
      const tenantId = ${JSON.stringify(tenantId)}, subscriptionId = ${JSON.stringify(subscriptionId)};
      await assert.rejects(new AzureCliCredential({tenantId, subscription: subscriptionId}).getToken(foundryScope), /only one of subscription and tenant/);
      await assert.rejects(bearerTokenProvider({mode:"entra",credential:"azure-cli",subscriptionId},
        new AzureCliCredential({tenantId, subscription: subscriptionId})),
        error => /Azure CLI option conflict/.test(error.message) && !/FAKE_PRIVATE|private@/.test(error.message));
      for (const selector of [{subscriptionId}, {tenantId}]) {
        const credential = createCredential({mode:"entra",credential:"azure-cli",...selector});
        const token = await credential.getToken(foundryScope, {abortSignal:AbortSignal.timeout(5000)});
        assert.equal(token.token, "FAKE_AZ_SUBPROCESS_TOKEN");
      }
      console.log("Exclusive token selectors passed without token output.");
    `;
    assert.match(execFileSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", env, timeout: 30000 }), /selectors passed/);
    const example = resolve("examples", "custom-campaign", "text-task.json");
    const config = JSON.parse(readFileSync(example, "utf8"));
    config.workspacePath = resolve(dirname(example), config.workspacePath);
    const configPath = join(root, "task.json");
    for (const selector of [{ subscriptionId }, { tenantId }]) {
      config.contract.foundryProvider.auth = { mode: "entra", credential: "azure-cli", ...selector };
      writeFileSync(configPath, JSON.stringify(config));
      const output = execFileSync(process.execPath, [resolve("dist", "doctor-cli.js"), "--config", configPath, "--acquire-auth"], {
        encoding: "utf8", env, timeout: 30000,
      });
      const result = JSON.parse(output);
      assert.equal(result.localChecksPassed, true);
      assert.equal(result.checks.find((check: { stage: string }) => check.stage === "credential-acquisition").status, "pass");
      assert.equal(result.checks.find((check: { stage: string }) => check.stage === "data-plane-inference").status, "not-verified");
      assert.doesNotMatch(output, /FAKE_AZ_SUBPROCESS_TOKEN|FAKE_PRIVATE|private@/);
    }
    const calls: string[][] = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(calls.length, 6);
    for (const args of calls) assert.deepEqual(args.slice(0, 6), ["account", "get-access-token", "--output", "json", "--resource", "https://ai.azure.com"]);
    for (const args of calls.slice(2)) assert.equal(Number(args.includes("--subscription")) + Number(args.includes("--tenant")), 1);
    assert.deepEqual(calls.slice(2).map((args) => args.slice(6)), [
      ["--subscription", subscriptionId], ["--tenant", tenantId], ["--subscription", subscriptionId], ["--tenant", tenantId],
    ]);
    config.contract.foundryProvider.auth = { mode: "entra", credential: "azure-cli", tenantId, subscriptionId };
    writeFileSync(configPath, JSON.stringify(config));
    const invalid = spawnSync(process.execPath, [resolve("dist", "doctor-cli.js"), "--config", configPath, "--acquire-auth"], {
      encoding: "utf8", env, timeout: 30000,
    });
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /only one of tenantId or subscriptionId/);
    assert.equal(readFileSync(log, "utf8").trim().split("\n").length, calls.length);
    assert.equal(readFileSync(defaults, "utf8"), initialDefaults);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
