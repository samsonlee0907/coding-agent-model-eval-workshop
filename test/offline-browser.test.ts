import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { chromium } from "playwright-core";
import { evidenceFromRuns } from "../src/evidence.js";
import { writeReportBundle } from "../src/publication.js";
import { fixtureConfig, fixtureRun } from "./fixtures/revamp.js";

const edgeAvailable = process.platform === "win32" && [
  join(process.env["ProgramFiles(x86)"] ?? "", "Microsoft", "Edge", "Application", "msedge.exe"),
  join(process.env.ProgramFiles ?? "", "Microsoft", "Edge", "Application", "msedge.exe"),
].some((p) => existsSync(p));
test("file:// report works offline at desktop/mobile, filters/exports, and inert approved preview routes", {
  timeout: 60000, skip: !edgeAvailable && !process.env.BENCHMARK_BROWSER_EXECUTABLE ? "Install Edge or set BENCHMARK_BROWSER_EXECUTABLE for the offline browser gate." : false,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "benchmark-browser-"));
  const browser = await chromium.launch({ channel: edgeAvailable ? "msedge" : undefined, executablePath: process.env.BENCHMARK_BROWSER_EXECUTABLE, headless: true });
  try {
    const runs = Array.from({ length: 40 }, (_, t) => Array.from({ length: 7 }, (_, c) => {
      const config = fixtureConfig("workspace", `Task-${t}`, `Candidate-${c}`);
      config.contract.task.taskType = t % 2 ? "custom-analysis" : "custom-build";
      return fixtureRun(`task-${t}-candidate-${c}`, config, (t + c) % 4 ? "pass" : "fail");
    })).flat();
    const evidence = evidenceFromRuns(runs), task = evidence.tasks[0].id;
    const html = '<script>parent.candidateScriptExecuted=true</script><h2>Approved inert output</h2><img src="https://blocked.test/a"><form><input></form>';
    writeFileSync(join(root, "candidate.html"), html);
    writeFileSync(join(root, "source.txt"), "Approved source fixture");
    writeFileSync(join(root, "output.json"), '{"answer":"OK"}');
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=", "base64");
    writeFileSync(join(root, "image.png"), png);
    const entries = [["html", "candidate.html"], ["text", "source.txt"], ["json", "output.json"], ["image", "image.png"]].map(([kind, path], i) => ({
      id: `preview-${i}`, title: `Approved ${kind}`, role: "output", task, attempt: runs[0].runId, root: "approved", path,
      kind, sha256: createHash("sha256").update(readFileSync(join(root, path))).digest("hex"), allowOriginalDownload: kind === "text",
    }));
    const index = writeReportBundle(evidence, join(root, "report"), { publication: { schemaVersion: 1, roots: { approved: root }, entries } });
    assert.ok(readFileSync(index).length < 3 * 1024 * 1024);
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    const errors: string[] = [], remote: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => { if (/^https?:/.test(request.url())) remote.push(request.url()); });
    await page.goto(pathToFileURL(index).href);
    assert.equal(await page.locator("#matrix [data-cell]").count(), 280);
    assert.equal(await page.locator("#usage-body tr").count(), 280);
    assert.equal(await page.locator(".usage-card").count(), 12);
    assert.match(await page.locator("#cell-detail .evidence-panel").textContent() ?? "", /SDK model-usage records/);
    assert.equal(await page.locator("#cell-detail > pre").count(), 0);
    assert.equal(await page.locator(".raw-evidence").getAttribute("open"), null);
    await page.locator("#type").selectOption("custom-build");
    assert.equal(await page.locator("#matrix-body tr:visible").count(), 20);
    await page.locator("#filter").fill("Task-2");
    assert.equal(await page.locator("#matrix-body tr:visible").count(), 6);
    await page.locator("#type").selectOption(""); await page.locator("#filter").fill("");
    const download = page.waitForEvent("download");
    await page.locator("#csv").click();
    const path = await (await download).path(); assert.ok(path);
    assert.equal(readFileSync(path, "utf8"), readFileSync(join(root, "report", "selected-results.csv"), "utf8"));
    const usageDownload = page.waitForEvent("download");
    await page.locator("#usage-csv").click();
    const usagePath = await (await usageDownload).path(); assert.ok(usagePath);
    assert.equal(readFileSync(usagePath, "utf8"), readFileSync(join(root, "report", "attempt-usage.csv"), "utf8"));
    assert.equal(await page.locator("iframe").getAttribute("sandbox"), "");
    assert.equal(await page.frameLocator("iframe").locator("h2").textContent(), "Approved inert output");
    assert.equal(await page.frameLocator("iframe").locator("script,form,img").count(), 0);
    assert.equal(await page.locator("#previews img").count(), 1);
    assert.equal(await page.evaluate(() => "candidateScriptExecuted" in window), false);
    const originalLink = page.getByRole("link", { name: "Open/save explicitly approved original (may be active content)" });
    assert.equal(await originalLink.count(), 1);
    assert.equal(await originalLink.getAttribute("rel"), "noopener noreferrer");
    const reportUrl = page.url();
    const popupPromise = page.waitForEvent("popup");
    await originalLink.click();
    const popup = await popupPromise; await popup.waitForLoadState();
    assert.match(await popup.locator("body").textContent() ?? "", /Approved source fixture/);
    assert.equal(page.url(), reportUrl);
    assert.equal(await popup.evaluate(() => window.opener === null), true);
    await popup.close();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.locator("#cell-selector").focus(); await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter");
    assert.ok((await page.locator("#cell-detail").textContent())?.includes("Latest clean execution"));
    assert.deepEqual(errors, []); assert.deepEqual(remote, []);
    await page.close();
  } finally { await browser.close(); rmSync(root, { recursive: true, force: true }); }
});

test("offline usage inspector keeps ungraded validation failures and interrupted counters readable without selecting missing work", {
  timeout: 60000, skip: !edgeAvailable && !process.env.BENCHMARK_BROWSER_EXECUTABLE ? "Install Edge or set BENCHMARK_BROWSER_EXECUTABLE for the offline browser gate." : false,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "benchmark-usage-browser-"));
  const browser = await chromium.launch({ channel: edgeAvailable ? "msedge" : undefined, executablePath: process.env.BENCHMARK_BROWSER_EXECUTABLE, headless: true });
  try {
    const completed = fixtureRun("validation-failed", fixtureConfig("workspace", "task", "candidate-a"), "ungraded");
    completed.validation!.exitCode = 1;
    completed.artifacts.normalizedEvents = join(root, "complete-events.ndjson");
    writeFileSync(completed.artifacts.normalizedEvents, Array.from({ length: 4 },
      () => JSON.stringify({ eventType: "assistant.turn_start", data: { content: "NEVER-PUBLISH" } })).join("\n"));
    const interrupted = fixtureRun("interrupted", fixtureConfig("workspace", "task", "candidate-b"), "ungraded");
    interrupted.executionStatus = "interrupted"; interrupted.runnerError = "fixture";
    interrupted.metrics.inputTokens = { status: "unavailable", value: null };
    interrupted.metrics.cacheReadTokens = { status: "unavailable", value: null };
    interrupted.requestAccounting!.physicalRequests = 2; interrupted.requestAccounting!.ambiguousRequests = 1;
    const evidence = evidenceFromRuns([completed, interrupted]);
    evidence.candidates.push({ id: "missing", model: "candidate-c", provider: "openai" });
    evidence.attempts[1].accounting.nativeTokenCount = { schemaVersion: 1, requests: 5, retries: 1, completed: 4, retryWaitMs: 10, fees: "unknown" };
    const index = writeReportBundle(evidence, join(root, "report"));
    assert.doesNotMatch(readFileSync(index, "utf8"), /NEVER-PUBLISH/);
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
    const errors: string[] = [], remote: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (/^https?:/.test(request.url())) remote.push(request.url()); });
    await page.goto(pathToFileURL(index).href);
    assert.equal(await page.locator("#matrix [data-cell]").count(), 3);
    assert.equal(await page.locator(".usage-card").count(), 2);
    assert.equal(await page.locator("#usage-body tr").count(), 2);
    const panel = page.locator("#cell-detail .evidence-panel");
    assert.match(await panel.textContent() ?? "", /Candidate validationFAIL \/ exit 1/);
    assert.match(await panel.textContent() ?? "", /Independent acceptanceUNGRADED/);
    assert.match(await panel.textContent() ?? "", /Observed agent turns4/);
    assert.match(await panel.textContent() ?? "", /Total tokens \(input \+ output\)130/);
    assert.equal(await page.locator(".raw-evidence").getAttribute("open"), null);
    await page.locator('#usage-body [data-attempt="interrupted"]').click();
    assert.match(await panel.textContent() ?? "", /Recorded attempt \/ not selected/);
    assert.match(await panel.textContent() ?? "", /Physical inference HTTP requests2/);
    assert.match(await panel.textContent() ?? "", /Native count HTTP requests \(not inference\)5/);
    assert.match(await panel.textContent() ?? "", /Observed agent turnsUnknown/);
    assert.match(await panel.textContent() ?? "", /Total tokens \(input \+ output\)Unknown/);
    await page.locator("#matrix .missing").click();
    assert.match(await page.locator("#cell-detail").textContent() ?? "", /No recorded attempt/);
    assert.equal(await page.locator("#cell-detail .evidence-panel").count(), 0);
    const download = page.waitForEvent("download");
    await page.locator("#usage-json").click();
    const path = await (await download).path(); assert.ok(path);
    assert.equal(readFileSync(path, "utf8"), readFileSync(join(root, "report", "attempt-usage.json"), "utf8"));
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    assert.deepEqual(errors, []); assert.deepEqual(remote, []);
    await page.close();
  } finally { await browser.close(); rmSync(root, { recursive: true, force: true }); }
});
