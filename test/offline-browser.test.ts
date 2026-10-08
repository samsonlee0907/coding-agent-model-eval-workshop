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
      kind, sha256: createHash("sha256").update(readFileSync(join(root, path))).digest("hex"), allowOriginalDownload: false,
    }));
    const index = writeReportBundle(evidence, join(root, "report"), { publication: { schemaVersion: 1, roots: { approved: root }, entries } });
    assert.ok(readFileSync(index).length < 3 * 1024 * 1024);
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    const errors: string[] = [], remote: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => { if (/^https?:/.test(request.url())) remote.push(request.url()); });
    await page.goto(pathToFileURL(index).href);
    assert.equal(await page.locator("[data-cell]").count(), 280);
    await page.locator("#type").selectOption("custom-build");
    assert.equal(await page.locator("#matrix-body tr:visible").count(), 20);
    await page.locator("#filter").fill("Task-2");
    assert.equal(await page.locator("#matrix-body tr:visible").count(), 6);
    await page.locator("#type").selectOption(""); await page.locator("#filter").fill("");
    const download = page.waitForEvent("download");
    await page.locator("#csv").click();
    const path = await (await download).path(); assert.ok(path);
    assert.equal(readFileSync(path, "utf8"), readFileSync(join(root, "report", "selected-results.csv"), "utf8"));
    assert.equal(await page.locator("iframe").getAttribute("sandbox"), "");
    assert.equal(await page.frameLocator("iframe").locator("h2").textContent(), "Approved inert output");
    assert.equal(await page.frameLocator("iframe").locator("script,form,img").count(), 0);
    assert.equal(await page.locator("#previews img").count(), 1);
    assert.equal(await page.evaluate(() => "candidateScriptExecuted" in window), false);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.locator("#cell-selector").focus(); await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter");
    assert.ok((await page.locator("#cell-detail").textContent())?.includes("Latest clean execution"));
    assert.deepEqual(errors, []); assert.deepEqual(remote, []);
    await page.close();
  } finally { await browser.close(); rmSync(root, { recursive: true, force: true }); }
});
