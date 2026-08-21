import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Pathspecs excluded from every captured diff. These are build/dependency
 * outputs an agent may generate; including them would bloat the patch and add
 * no signal about the code the model actually authored.
 *
 * Lockfiles are excluded for a second reason: they are enormous and sort early
 * in git's path order, so leaving them in silently consumes a downstream
 * reviewer's diff budget (for example the LLM judge's `maximumDiffCharacters`)
 * before any `src/` hunk is reached. Declared dependency ranges are still
 * visible via `package.json`, which is kept.
 */
const excludedPathspecs = [
  ":(exclude)node_modules",
  ":(exclude)dist",
  ":(exclude)build",
  ":(exclude).benchmark-artifacts",
  ":(exclude).benchmark-runs",
  ":(exclude)package-lock.json",
  ":(exclude)npm-shrinkwrap.json",
  ":(exclude)yarn.lock",
  ":(exclude)pnpm-lock.yaml",
  ":(exclude)bun.lockb",
  ":(exclude)*.lock",
];

const maximumPatchCharacters = 200_000;

export interface WorkspaceChangeCapture {
  /** Unified source-only diff vs the baseline, or `null` when unavailable. */
  patch: string | null;
  filesChanged: number | null;
  insertions: number | null;
  deletions: number | null;
  /** Populated only when `patch` is `null`, explaining why. */
  reason?: string;
}

/**
 * Captures the agent's code changes as a unified diff of the working tree
 * against the task's baseline commit. Non-mutating: it stages into a throwaway
 * `GIT_INDEX_FILE` so the real repository index is never touched. New,
 * modified, and deleted files (tracked or untracked) are all reflected.
 *
 * Returns `patch: null` with a `reason` when the workspace is not a git
 * repository, git is unavailable, or the baseline commit cannot be resolved —
 * so callers can label the code diff unavailable rather than inventing one.
 */
export function captureWorkspaceChanges(
  workspacePath: string,
  baselineCommitSha: string,
): WorkspaceChangeCapture {
  const indexDirectory = mkdtempSync(join(tmpdir(), "benchmark-index-"));
  const throwawayIndex = join(indexDirectory, "index");
  const stagingEnv = { ...process.env, GIT_INDEX_FILE: throwawayIndex };
  try {
    git(["rev-parse", "--is-inside-work-tree"], workspacePath, process.env);
    // Seed the throwaway index from the working tree only; the real index is untouched.
    // No explicit pathspec here: an explicit `.` makes `git add` fail when the
    // workspace's own .gitignore ignores present paths (e.g. node_modules/dist
    // after the agent installed dependencies). Ignored paths are skipped silently,
    // and the diff below still applies the exclude pathspecs as a safety net.
    git(["add", "-A"], workspacePath, stagingEnv);
    const stat = parseNumstat(
      git(["diff", "--cached", "--numstat", baselineCommitSha, "--", ".", ...excludedPathspecs], workspacePath, stagingEnv),
    );
    let patch = git(
      ["diff", "--cached", "--no-color", "--no-ext-diff", baselineCommitSha, "--", ".", ...excludedPathspecs],
      workspacePath,
      stagingEnv,
    );
    if (patch.length > maximumPatchCharacters) {
      patch = `${patch.slice(0, maximumPatchCharacters)}\n[patch truncated at ${maximumPatchCharacters} characters]\n`;
    }
    return { patch, filesChanged: stat.filesChanged, insertions: stat.insertions, deletions: stat.deletions };
  } catch (error) {
    const message = error instanceof Error ? error.message.split(/\r?\n/)[0] : "git diff unavailable";
    return { patch: null, filesChanged: null, insertions: null, deletions: null, reason: message };
  } finally {
    rmSync(indexDirectory, { recursive: true, force: true });
  }
}

function parseNumstat(numstat: string): { filesChanged: number; insertions: number; deletions: number } {
  const lines = numstat.split(/\r?\n/).filter((line) => line.trim().length > 0);
  let insertions = 0;
  let deletions = 0;
  for (const line of lines) {
    const [added, removed] = line.split("\t");
    if (added && added !== "-") {
      insertions += Number(added) || 0;
    }
    if (removed && removed !== "-") {
      deletions += Number(removed) || 0;
    }
  }
  return { filesChanged: lines.length, insertions, deletions };
}

function git(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): string {
  return execFileSync("git", args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}
