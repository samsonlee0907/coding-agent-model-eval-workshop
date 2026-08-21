import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureWorkspaceChanges } from "../src/workspace-changes.js";

function git(args: readonly string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function initRepo(): { path: string; baseline: string } {
  const path = mkdtempSync(join(tmpdir(), "ws-changes-"));
  git(["init", "-q"], path);
  git(["config", "user.email", "test@example.com"], path);
  git(["config", "user.name", "Test"], path);
  git(["config", "commit.gpgsign", "false"], path);
  writeFileSync(join(path, "keep.ts"), "export const value = 1;\n", "utf8");
  git(["add", "-A"], path);
  git(["commit", "-q", "-m", "baseline"], path);
  const baseline = git(["rev-parse", "HEAD"], path).trim();
  return { path, baseline };
}

test("captures a diff spanning a modified tracked file and a new untracked file", () => {
  const { path, baseline } = initRepo();
  try {
    writeFileSync(join(path, "keep.ts"), "export const value = 2;\n", "utf8");
    writeFileSync(join(path, "added.ts"), "export const order = { id: 1 };\n", "utf8");
    const capture = captureWorkspaceChanges(path, baseline);
    assert.ok(capture.patch, "expected a non-null patch");
    assert.match(capture.patch!, /keep\.ts/);
    assert.match(capture.patch!, /added\.ts/);
    assert.ok((capture.filesChanged ?? 0) >= 2, "expected at least two changed files");
    assert.ok((capture.insertions ?? 0) >= 2, "expected recorded insertions");
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});

test("excludes lockfiles so they cannot consume a downstream diff budget", () => {
  const { path, baseline } = initRepo();
  try {
    writeFileSync(join(path, "package-lock.json"), `{"lockfileVersion":3,"packages":{}}\n${"// filler\n".repeat(500)}`, "utf8");
    writeFileSync(join(path, "pnpm-lock.yaml"), "lockfileVersion: 9\n", "utf8");
    writeFileSync(join(path, "src.ts"), "export const store = new Map();\n", "utf8");
    const capture = captureWorkspaceChanges(path, baseline);
    assert.ok(capture.patch, "expected a non-null patch");
    assert.match(capture.patch!, /src\.ts/, "hand-authored source must still be captured");
    assert.doesNotMatch(capture.patch!, /package-lock\.json/);
    assert.doesNotMatch(capture.patch!, /pnpm-lock\.yaml/);
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});

test("leaves the real index untouched after capture", () => {
  const { path, baseline } = initRepo();
  try {
    writeFileSync(join(path, "added.ts"), "export const order = 1;\n", "utf8");
    captureWorkspaceChanges(path, baseline);
    // The throwaway index must not have staged anything into the real index.
    const staged = git(["diff", "--cached", "--name-only"], path).trim();
    assert.equal(staged, "");
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});

test("returns patch:null with a reason for a non-git path", () => {
  const path = mkdtempSync(join(tmpdir(), "ws-nonrepo-"));
  try {
    const capture = captureWorkspaceChanges(path, "0000000000000000000000000000000000000000");
    assert.equal(capture.patch, null);
    assert.equal(capture.filesChanged, null);
    assert.ok(capture.reason && capture.reason.length > 0);
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});
