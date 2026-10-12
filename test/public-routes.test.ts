import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("all advertised compiled CLIs expose side-effect-free help before reading inputs or credentials", () => {
  const root = mkdtempSync(join(tmpdir(), "benchmark-cli-help-"));
  try {
    for (const script of ["cli", "doctor-cli", "campaign-cli", "quickstart-cli", "html-report-cli", "portfolio-cli", "pricing-cli", "evaluator-cli"]) {
      const text = execFileSync(process.execPath, [resolve("dist", `${script}.js`), "--help", "--config", "missing.json", "--runs", "missing"], {
        cwd: root, encoding: "utf8", env: { ...process.env, FOUNDRY_ENDPOINT: "invalid", FOUNDRY_API_KEY: "" },
      });
      assert.match(text, /Usage:/, script);
      assert.deepEqual(readdirSync(root), [], script);
      if (script === "evaluator-cli") {
        for (const flag of ["--auth", "--credential", "--tenant-id", "--subscription-id", "--wire-api", "--bounds"]) assert.ok(text.includes(flag));
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("public paid quickstart/judge reject absent bounds and offline quickstart persists the shared limits", () => {
  const root = mkdtempSync(join(tmpdir(), "benchmark-cli-bounds-"));
  try {
    for (const [script, args] of [
      ["quickstart-cli", ["--model", "fixture-model", "--task", "Public fixture"]],
      ["evaluator-cli", ["--model", "fixture-model", "--runs", "missing"]],
    ] as const) {
      const reply = spawnSync(process.execPath, [resolve("dist", `${script}.js`), "--provider", "openai", ...args], { cwd: root, encoding: "utf8" });
      assert.equal(reply.status, 2);
      assert.match(reply.stderr, /requires --bounds/);
      assert.deepEqual(readdirSync(root), []);
    }
    const bounds = resolve("examples", "request-bounds.example.json"), output = join(root, "prepared");
    const text = execFileSync(process.execPath, [resolve("dist", "quickstart-cli.js"), "--provider", "openai", "--model", "fixture-model", "--task", "Public fixture",
      "--bounds", bounds, "--prepare-only", "--output", output, "--wire-api", "responses", "--auth", "entra", "--credential", "azure-cli",
      "--tenant-id", "11111111-2222-4333-8444-555555555555", "--subscription-id", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"], {
      cwd: root, encoding: "utf8", env: { ...process.env, FOUNDRY_ENDPOINT: "", FOUNDRY_API_KEY: "" },
    });
    assert.equal(JSON.parse(text).inference, "not-dispatched");
    const config = JSON.parse(readFileSync(join(output, "benchmark.local.json"), "utf8"));
    assert.deepEqual(config.requestBounds, JSON.parse(readFileSync(bounds, "utf8")));
    const doctorText = execFileSync(process.execPath, [resolve("dist", "doctor-cli.js"), "--config", join(output, "benchmark.local.json"), "--verify-runtime"], {
      cwd: root, encoding: "utf8", timeout: 90000, env: { ...process.env, FOUNDRY_ENDPOINT: "", FOUNDRY_API_KEY: "" },
    });
    const doctor = JSON.parse(doctorText);
    assert.equal(doctor.localChecksPassed, true);
    assert.equal(doctor.auth.mode, "entra");
    assert.equal(doctor.auth.subscriptionId, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    assert.equal(doctor.runtimeVerification.passed, true);
    assert.equal(doctor.runtimeVerification.fileHashes.length, 2);
    assert.equal(doctor.checks.find((check: { stage: string }) => check.stage === "credential-acquisition").status, "not-verified");
    assert.equal(doctor.checks.find((check: { stage: string }) => check.stage === "data-plane-inference").status, "not-verified");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
