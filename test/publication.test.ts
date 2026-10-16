import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, symlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { unzipSync } from "fflate";
import { evidenceFromRuns } from "../src/evidence.js";
import { prepareApprovedPreviews, writeReportBundle, verifyReportBundle, spreadsheetSafe, toCsv, safeRelativePath, attemptUsageRows, selectedResultRows } from "../src/publication.js";
import { renderEvidenceReport } from "../src/report-ui.js";
import { fixtureRun, fixtureConfig } from "./fixtures/revamp.js";
import { immutableContractHash } from "../src/contract.js";
import { azureOpenAiPricingUrl, type PricingSnapshot } from "../src/pricing.js";

test("metadata-safe default bundle and ZIP are portable, consistent and hash-verified", () => {
  const root = mkdtempSync(join(tmpdir(), "benchmark-publication-"));
  try {
    const run = fixtureRun("a"); run.validation!.stdout = "DO-NOT-PUBLISH";
    run.contract.task.prompt = "PRIVATE-PROMPT"; // Rebind the intentionally private fixture prompt.
    run.contractHash = immutableContractHash(run.contract);
    const evidence = evidenceFromRuns([run]);
    const path = writeReportBundle(evidence, join(root, "report"), { zip: true });
    verifyReportBundle(join(root, "report"));
    const html = readFileSync(path, "utf8");
    assert.match(html, /Coding Agent Model Benchmark/); assert.match(html, /latest cleanly completed execution/);
    assert.match(html, /id="pricing"/); assert.match(html, /Pricing UNKNOWN/);
    assert.doesNotMatch(html, /DO-NOT-PUBLISH|PRIVATE-PROMPT|https?:\/\/|fetch\(/);
    assert.deepEqual(JSON.parse(readFileSync(join(root, "report", "selected-results.json"), "utf8")).map((r: { status: string }) => r.status), ["pass"]);
    const zip = unzipSync(readFileSync(join(root, "report.zip")));
    assert.ok(zip["index.html"]); assert.ok(zip["evidence.json"]); assert.equal(Object.keys(zip).length, 13);
    assert.ok(zip["attempt-usage.json"]); assert.ok(zip["attempt-usage.csv"]);
    assert.ok(zip["pricing.json"]); assert.ok(zip["pricing-estimates.csv"]); assert.ok(zip["pricing-options.json"]);
    assert.equal(zip["pricing-snapshot.json"], undefined);
    writeFileSync(join(root, "report", "evidence.json"), "{}");
    assert.throws(() => verifyReportBundle(join(root, "report")), /integrity/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("saved pricing is first-class, scenario-explicit, and integrity-bound in portable reports", () => {
  const root = mkdtempSync(join(tmpdir(), "benchmark-pricing-publication-"));
  try {
    const evidence = evidenceFromRuns([fixtureRun("priced")]);
    const pricing: PricingSnapshot = {
      schemaVersion: 1, refreshedAt: "2026-10-16T00:00:00.000Z", regionFilter: "global", currency: "USD",
      sources: [{
        provider: "openai", pricingUrl: azureOpenAiPricingUrl, documentationUrl: null,
        extendedCachePricingUrl: null, contentHash: "a".repeat(64),
      }],
      candidates: [{
        candidate: "openai/candidate-a/candidate-a",
        recorded: { provider: "openai", model: "candidate-a", deployment: "candidate-a" },
        sourceUrl: azureOpenAiPricingUrl, unavailableReason: null,
        scenarios: [{
          id: "candidate-a-global", provider: "openai", officialModel: "Candidate A", region: "global", cacheTtl: null,
          input: { kind: "input", retailPrice: 1, region: "global", cacheTtl: null },
          cachedInput: { kind: "cached-input", retailPrice: .1, region: "global", cacheTtl: null },
          cacheWrite: { kind: "cache-write", retailPrice: 1.25, region: "global", cacheTtl: null },
          output: { kind: "output", retailPrice: 2, region: "global", cacheTtl: null },
          unavailableReason: null,
        }],
      }],
    };
    const index = writeReportBundle(evidence, join(root, "report"), { pricing, zip: true });
    verifyReportBundle(join(root, "report"));
    const html = readFileSync(index, "utf8");
    assert.match(html, /A saved snapshot is attached/);
    assert.match(html, /Unit prices and sources per model/);
    assert.match(html, /\$0\.000160/);
    assert.match(html, /Selected and all-attempt\/recovery totals/);
    assert.match(html, /<a href="https:\/\/azure\.microsoft\.com\/en-us\/pricing\/details\/azure-openai\/" target="_blank" rel="noopener noreferrer">/);
    assert.match(html, /global \/ Candidate A: \$0\.000160/);
    assert.match(html, /class="chart-scroll"/);
    assert.deepEqual(JSON.parse(readFileSync(join(root, "report", "pricing-snapshot.json"), "utf8")), pricing);
    const view = JSON.parse(readFileSync(join(root, "report", "pricing.json"), "utf8"));
    assert.equal(view.estimates[0].selectedUsd, .00016);
    assert.equal(view.snapshot.sha256,
      createHash("sha256").update(readFileSync(join(root, "report", "pricing-snapshot.json"))).digest("hex"));
    const zip = unzipSync(readFileSync(join(root, "report.zip")));
    assert.ok(zip["pricing-snapshot.json"]); assert.ok(zip["pricing.json"]); assert.ok(zip["pricing-estimates.csv"]);
    const evidencePath = join(root, "evidence.json"), pricingPath = join(root, "pricing-snapshot.json");
    writeFileSync(evidencePath, JSON.stringify(evidence)); writeFileSync(pricingPath, JSON.stringify(pricing));
    const cliBundle = join(root, "evidence-cli-report");
    execFileSync(process.execPath, [resolve("dist", "html-report-cli.js"), "--evidence", evidencePath,
      "--pricing", pricingPath, "--bundle", cliBundle, "--zip"], { encoding: "utf8", timeout: 15000 });
    verifyReportBundle(cliBundle);
    assert.equal(JSON.parse(readFileSync(join(cliBundle, "pricing.json"), "utf8")).estimates[0].selectedUsd, .00016);
    writeFileSync(join(root, "report", "pricing-snapshot.json"), "{}");
    assert.throws(() => verifyReportBundle(join(root, "report")), /integrity/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("previous version-1 bundles remain verifiable without new usage exports or optional columns", () => {
  const root = mkdtempSync(join(tmpdir(), "benchmark-legacy-bundle-"));
  try {
    const directory = join(root, "report");
    writeReportBundle(evidenceFromRuns([fixtureRun("legacy")]), directory);
    const columns = ["task", "candidate", "repeat", "status", "runId", "selectionReason", "attempts", "validation",
      "requiredFailed", "execution", "phase", "advisoryFailed", "checkErrors", "wallMs", "inputTokens", "outputTokens",
      "recordedUsd", "recordedCostMultiplier", "allAttemptRecordedCostMultiplier", "contractHash", "promptHash", "policyHash", "workspaceHash"];
    const selected = selectedResultRows(evidenceFromRuns([fixtureRun("legacy")])).map(row =>
      Object.fromEntries(columns.map(column => [column, row[column as keyof typeof row]])));
    writeFileSync(join(directory, "selected-results.json"), `${JSON.stringify(selected, null, 2)}\n`);
    writeFileSync(join(directory, "selected-results.csv"), toCsv(selected, columns));
    rmSync(join(directory, "attempt-usage.json")); rmSync(join(directory, "attempt-usage.csv"));
    rmSync(join(directory, "pricing.json")); rmSync(join(directory, "pricing-estimates.csv")); rmSync(join(directory, "pricing-options.json"));
    const integrity = JSON.parse(readFileSync(join(directory, "integrity.json"), "utf8"));
    integrity.files = integrity.files.filter((file: { path: string }) =>
      !file.path.startsWith("attempt-usage.") && !file.path.startsWith("pricing"));
    for (const file of integrity.files) {
      const bytes = readFileSync(join(directory, file.path));
      file.bytes = bytes.length; file.sha256 = createHash("sha256").update(bytes).digest("hex");
    }
    writeFileSync(join(directory, "integrity.json"), JSON.stringify(integrity));
    verifyReportBundle(directory);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("descriptive usage and exports include ungraded, validation-failed and interrupted attempts without filling cross-policy cells", () => {
  const root = mkdtempSync(join(tmpdir(), "benchmark-usage-exports-"));
  try {
    const a = fixtureRun("complete-a", fixtureConfig("workspace", "same-task", "candidate-a"), "ungraded");
    const b = fixtureRun("complete-b", fixtureConfig("workspace", "same-task", "candidate-b"), "ungraded");
    b.contract.execution.instructions = "Distinct immutable policy";
    b.contractHash = immutableContractHash(b.contract); b.validation!.exitCode = 1;
    const interrupted = fixtureRun("interrupted-a", fixtureConfig("workspace", "same-task", "candidate-a"), "ungraded");
    interrupted.executionStatus = "interrupted"; interrupted.runnerError = "fixture interruption";
    interrupted.metrics.outputTokens = { status: "unavailable", value: null };
    interrupted.requestAccounting!.physicalRequests = 2;
    const evidence = evidenceFromRuns([a, b, interrupted]);
    evidence.attempts[0].metrics.agentTurns = 3; evidence.attempts[0].metrics.toolCalls = 9;
    evidence.attempts[1].accounting.nativeTokenCount = { schemaVersion: 1, requests: 5, retries: 1, completed: 4,
      retryWaitMs: 10, fees: "unknown" };
    const usage = attemptUsageRows(evidence);
    assert.equal(usage.length, 3);
    assert.equal(usage[0].agentTurns, 3); assert.equal(usage[0].toolCalls, 9);
    assert.equal(usage[0].totalTokens, 130); assert.equal(usage[0].nativeCountRequests, null);
    assert.equal(usage[0].physicalInferenceRequests, 1);
    assert.equal(usage[1].validation, "fail"); assert.equal(usage[1].acceptance, "ungraded");
    assert.equal(usage[1].nativeCountRequests, 5); assert.equal(usage[1].physicalInferenceRequests, 1);
    assert.equal(usage[2].selected, false); assert.equal(usage[2].totalTokens, null);
    assert.equal(usage[2].physicalInferenceRequests, 2);
    const selected = selectedResultRows(evidence);
    assert.equal(selected.length, 4); assert.equal(selected.filter(row => row.status === "missing").length, 2);
    assert.ok(selected.filter(row => row.status === "missing").every(row => row.totalTokens === null
      && row.agentTurns === null && row.modelUsageRecords === null && row.physicalInferenceRequests === null));
    const index = writeReportBundle(evidence, join(root, "report"), { zip: true });
    assert.deepEqual(JSON.parse(readFileSync(join(root, "report", "attempt-usage.json"), "utf8")), usage);
    assert.equal(readFileSync(join(root, "report", "attempt-usage.csv"), "utf8"), toCsv(usage, Object.keys(usage[0])));
    const html = readFileSync(index, "utf8"), visible = html.slice(html.indexOf('<section id="usage">'), html.indexOf('<section id="insights">'));
    assert.match(visible, /complete-a/); assert.match(visible, /complete-b/); assert.match(visible, /interrupted-a/);
    assert.match(visible, /Validation: FAIL \(exit 1\)/); assert.match(visible, /Acceptance: UNGRADED/);
    assert.match(visible, /Count HTTP <b>Unknown/); assert.match(visible, /Inference HTTP <b>2/);
    assert.match(visible, /not a ranking/); assert.match(html, /raw-evidence/);
    verifyReportBundle(join(root, "report"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("built --runs and --evidence CLI routes keep usage identical in bundles and explicit single-file reports", { timeout: 60000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "benchmark-usage-cli-"));
  try {
    const run = fixtureRun("recorded", fixtureConfig("workspace", "task", "candidate"), "ungraded");
    run.artifacts.directory = join(root, "runs", run.runId);
    run.artifacts.normalizedEvents = join(run.artifacts.directory, "normalized-events.ndjson");
    mkdirSync(run.artifacts.directory, { recursive: true });
    writeFileSync(run.artifacts.normalizedEvents, Array.from({ length: 3 },
      () => JSON.stringify({ eventType: "assistant.turn_start", data: {} })).join("\n"));
    writeFileSync(join(run.artifacts.directory, "run.json"), JSON.stringify(run));
    const evidence = evidenceFromRuns([run]), evidencePath = join(root, "evidence.json");
    writeFileSync(evidencePath, JSON.stringify(evidence));
    for (const [source, input] of [["--runs", join(root, "runs")], ["--evidence", evidencePath]]) {
      const output = join(root, `report-${source.slice(2)}`);
      execFileSync(process.execPath, [resolve("dist", "html-report-cli.js"), source, input, "--bundle", output, "--zip"],
        { encoding: "utf8", timeout: 15000 });
      verifyReportBundle(output);
      const rows = JSON.parse(readFileSync(join(output, "attempt-usage.json"), "utf8"));
      assert.equal(rows[0].totalTokens, 130); assert.equal(rows[0].agentTurns, 3);
      assert.equal(rows[0].toolCalls, 0); assert.equal(rows[0].modelUsageRecords, 0);
      assert.equal(rows[0].physicalInferenceRequests, 1); assert.equal(rows[0].nativeCountRequests, null);
      assert.equal(rows[0].acceptance, "ungraded");
      const single = `${output}.html`;
      execFileSync(process.execPath, [resolve("dist", "html-report-cli.js"), source, input, "--output", single],
        { encoding: "utf8", timeout: 15000 });
      const html = readFileSync(single, "utf8");
      assert.match(html, /<section id="usage">/);
      assert.match(html.slice(html.indexOf('<section id="usage">'), html.indexOf('<section id="insights">')),
        /Turns <b>3/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("only reviewed, byte-bound publication entries can expose sources/outputs", () => {
  const root = mkdtempSync(join(tmpdir(), "benchmark-approved-"));
  try {
    const evidence = evidenceFromRuns([fixtureRun("a")]);
    const content = '<script>window.parent.pwned=true</script><p onclick="evil()">Approved text</p><img src="https://evil.test/a"><form action="https://evil.test"><input></form><a href="javascript:evil()">link</a>';
    writeFileSync(join(root, "candidate.html"), content);
    const entry = { id: "approved", title: "Final output", task: evidence.tasks[0].id, attempt: "a", role: "output",
      root: "outputs", path: "candidate.html", sha256: createHash("sha256").update(content).digest("hex"), kind: "html", allowOriginalDownload: false };
    const manifest = { schemaVersion: 1, roots: { outputs: root }, entries: [entry] };
    const approved = prepareApprovedPreviews(manifest, evidence);
    assert.match(approved.previews[0].content!, /Approved text/);
    assert.doesNotMatch(approved.previews[0].content!, /<script|onclick|<img|<form|javascript:|evil\.test/);
    assert.equal(approved.originals.size, 0);
    assert.throws(() => prepareApprovedPreviews({ ...manifest, entries: [{ ...entry, sha256: "a".repeat(64) }] }, evidence), /hash/);
    assert.throws(() => prepareApprovedPreviews({ ...manifest, entries: [{ ...entry, attempt: "unknown" }] }, evidence), /binding/);
    assert.throws(() => prepareApprovedPreviews({ ...manifest, entries: [{ ...entry, path: "..\\candidate.html" }] }, evidence), /traversal/);
    const html = renderEvidenceReport(evidence, approved.previews);
    assert.match(html, /setAttribute\("sandbox",""\)/); assert.match(html, /connect-src 'none'/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("unsupported/invalid previews are explicit; failed staging preserves prior reports", () => {
  const root = mkdtempSync(join(tmpdir(), "benchmark-failed-publication-"));
  try {
    const evidence = evidenceFromRuns([fixtureRun("a")]);
    writeFileSync(join(root, "bad.json"), "not json");
    const entry = { id: "bad", title: "Invalid output", task: evidence.tasks[0].id, attempt: "a", role: "output",
      root: "r", path: "bad.json", sha256: createHash("sha256").update("not json").digest("hex"), kind: "json" };
    const manifest = { schemaVersion: 1, roots: { r: root }, entries: [entry] };
    assert.equal(prepareApprovedPreviews(manifest, evidence).previews[0].status, "invalid");
    mkdirSync(join(root, "good")); writeFileSync(join(root, "good", "index.html"), "GOOD");
    assert.throws(() => writeReportBundle(evidence, join(root, "good")), /exists/);
    assert.equal(readFileSync(join(root, "good", "index.html"), "utf8"), "GOOD");
    assert.throws(() => writeReportBundle(evidence, join(root, "new"), { publication: { ...manifest, entries: [{ ...entry, sha256: "b".repeat(64) }] } }), /hash/);
    assert.equal(existsSync(join(root, "new")), false);
    assert.equal(readdirSync(root).filter((f) => f.includes(".stage-")).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("preview file resolver rejects junctions and spreadsheet exports neutralize formulas", () => {
  const root = mkdtempSync(join(tmpdir(), "benchmark-export-path-"));
  try {
    mkdirSync(join(root, "real")); writeFileSync(join(root, "real", "content.txt"), "content");
    symlinkSync(join(root, "real"), join(root, "junction"), process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => safeRelativePath(root, "junction\\content.txt"), /symlink|junction/);
    for (const value of ["=SUM(1)", " \t@evil", "-1+cmd", "+cmd", "\nformula"]) assert.ok(spreadsheetSafe(value).startsWith("'"));
    assert.equal(toCsv([{ candidate: '=HYPERLINK("bad")', metric: null }], ["candidate", "metric"]), `"candidate","metric"\r\n"'=HYPERLINK(""bad"")",""\r\n`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
