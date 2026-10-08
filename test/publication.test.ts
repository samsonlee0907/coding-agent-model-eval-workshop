import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, symlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { evidenceFromRuns } from "../src/evidence.js";
import { prepareApprovedPreviews, writeReportBundle, verifyReportBundle, spreadsheetSafe, toCsv, safeRelativePath } from "../src/publication.js";
import { renderEvidenceReport } from "../src/report-ui.js";
import { fixtureRun } from "./fixtures/revamp.js";
import { immutableContractHash } from "../src/contract.js";

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
    assert.doesNotMatch(html, /DO-NOT-PUBLISH|PRIVATE-PROMPT|https?:\/\/|fetch\(/);
    assert.deepEqual(JSON.parse(readFileSync(join(root, "report", "selected-results.json"), "utf8")).map((r: { status: string }) => r.status), ["pass"]);
    const zip = unzipSync(readFileSync(join(root, "report.zip")));
    assert.ok(zip["index.html"]); assert.ok(zip["evidence.json"]); assert.equal(Object.keys(zip).length, 8);
    writeFileSync(join(root, "report", "evidence.json"), "{}");
    assert.throws(() => verifyReportBundle(join(root, "report")), /integrity/);
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
