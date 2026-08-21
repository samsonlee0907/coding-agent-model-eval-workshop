import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type {
  ArtifactInspection,
  ArtifactSourceFile,
  BenchmarkRun,
  DependencyDrift,
  EntryPointCheck,
  ExportedSymbol,
  InspectedFile,
  InspectedFileRole,
} from "./types.js";

/** Directories that never contain reviewable, agent-authored artifact code. */
const skippedDirectories = new Set([
  "node_modules",
  ".git",
  ".benchmark-artifacts",
  ".benchmark-runs",
  "coverage",
  ".cache",
  ".turbo",
  ".next",
  ".nuxt",
  ".venv",
  "__pycache__",
]);

/** Compiler/bundler output. Present in the inventory, excluded from review. */
const buildOutputDirectories = new Set(["dist", "build", "out", "lib", "es", "esm", "cjs", ".output"]);

const sourceExtensions = new Set([
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs",
  ".vue", ".svelte", ".py", ".go", ".rs", ".java", ".rb", ".cs", ".php",
]);

const configFileNames = new Set([
  "package.json", "tsconfig.json", "jsconfig.json", ".npmrc", ".nvmrc",
  "vitest.config.ts", "vitest.config.js", "jest.config.js", "jest.config.ts",
  "eslint.config.js", "eslint.config.mjs", ".eslintrc", ".eslintrc.json",
  "pyproject.toml", "go.mod", "Cargo.toml", "Makefile", "Dockerfile",
]);

const maximumFilesWalked = 4_000;
const maximumWalkDepth = 12;
const maximumFileCharacters = 64_000;
const maximumTotalSourceCharacters = 600_000;

/**
 * Reads a finished task workspace and produces the deterministic code-artifact
 * evidence the harness cannot get from a diff alone: the *final* state of every
 * hand-authored file, the package manifest, and a set of integrity checks that
 * a passing validation command can silently hide.
 *
 * Everything here is measured, never inferred. When the workspace is gone or
 * unreadable the inspection is returned with `available: false` and a reason, so
 * downstream consumers can label the gap instead of guessing at code.
 */
export function inspectArtifact(workspacePath: string): ArtifactInspection {
  const root = resolve(workspacePath);
  const capturedAt = new Date().toISOString();
  if (!existsSync(root)) {
    return unavailableInspection(root, capturedAt, "the task workspace no longer exists on this machine");
  }
  let files: InspectedFile[];
  try {
    files = walkWorkspace(root);
  } catch (error) {
    return unavailableInspection(root, capturedAt, `the task workspace could not be read: ${describeError(error)}`);
  }

  const manifestFile = files.find((file) => file.path === "package.json");
  const manifest = manifestFile ? readFileSafely(join(root, "package.json")) : null;
  const manifestRecord = parseJsonRecord(manifest);
  const reviewable = files.filter(isReviewable);

  return {
    schemaVersion: 1,
    capturedAt,
    root,
    available: true,
    files,
    totals: summarizeTotals(files),
    manifest,
    entryPoints: manifestRecord ? checkEntryPoints(root, manifestRecord) : [],
    dependencyDrift: manifestRecord ? detectDependencyDrift(root, manifestRecord) : [],
    testFilesUnderBuildOutput: files
      .filter((file) => file.role === "test" && file.underBuildOutput)
      .map((file) => file.path),
    exports: collectExports(root, reviewable),
    sources: readSources(root, reviewable),
  };
}

/**
 * Resolves a run's code-artifact inspection. Prefers the immutable copy captured
 * at run time; falls back to inspecting the recorded workspace live for runs
 * recorded before capture existed. Never throws — an unreadable artifact is
 * reported as unavailable so callers keep labelling rather than inventing.
 */
export function loadArtifactInspection(run: BenchmarkRun): ArtifactInspection {
  const capturedAt = new Date().toISOString();
  const persisted = run.artifacts.inspection ?? join(run.artifacts.directory, "artifact-inspection.json");
  if (existsSync(persisted)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(persisted, "utf8"));
      if (isRecord(parsed) && parsed.schemaVersion === 1) {
        return parsed as unknown as ArtifactInspection;
      }
    } catch {
      // fall through to live inspection
    }
  }
  if (run.artifacts.workspace) {
    return inspectArtifact(run.artifacts.workspace);
  }
  return unavailableInspection(
    run.artifacts.directory,
    capturedAt,
    "this run recorded no workspace path and no artifact inspection was captured",
  );
}

/**
 * Renders the artifact's reviewable files as line-numbered text for a reviewer.
 * Line numbers are what make `file:line` citations checkable, so they are part
 * of the evidence contract rather than presentation. Source is emitted before
 * tests and configuration, and only the tail is dropped when the budget binds.
 */
export function renderSourceBundle(inspection: ArtifactInspection, budgetCharacters: number): string {
  if (!inspection.available) {
    return `unavailable - ${inspection.reason ?? "the code artifact could not be inspected"}`;
  }
  if (inspection.sources.length === 0) {
    return "empty - the workspace contained no reviewable source, test, or configuration files";
  }
  const ordered = [...inspection.sources].sort((left, right) => reviewOrder(left.role) - reviewOrder(right.role));
  const blocks: string[] = [];
  let used = 0;
  const omitted: string[] = [];
  for (const file of ordered) {
    const block = `--- ${file.path} (${file.role}, ${file.lines} lines) ---\n${numberLines(file.content)}\n`;
    if (used + block.length > budgetCharacters && blocks.length > 0) {
      omitted.push(file.path);
      continue;
    }
    blocks.push(block);
    used += block.length;
  }
  if (omitted.length > 0) {
    blocks.push(`--- omitted for budget (${omitted.length} file(s)) ---\n${omitted.join("\n")}\n`);
  }
  return blocks.join("\n");
}

/** Reviewable = hand-authored. Build output and dependencies are excluded. */
function isReviewable(file: InspectedFile): boolean {
  return !file.underBuildOutput && (file.role === "source" || file.role === "test" || file.role === "config");
}

function reviewOrder(role: InspectedFileRole): number {
  return role === "source" ? 0 : role === "test" ? 1 : role === "config" ? 2 : 3;
}

function numberLines(content: string): string {
  const lines = content.split("\n");
  const width = String(lines.length).length;
  return lines.map((line, index) => `${String(index + 1).padStart(width, " ")}| ${line}`).join("\n");
}

function walkWorkspace(root: string): InspectedFile[] {
  const files: InspectedFile[] = [];
  const walk = (directory: string, depth: number): void => {
    if (depth > maximumWalkDepth || files.length >= maximumFilesWalked) {
      return;
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (files.length >= maximumFilesWalked) {
        return;
      }
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!skippedDirectories.has(entry.name)) {
          walk(absolute, depth + 1);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const path = toPosix(relative(root, absolute));
      const segments = path.split("/");
      const underBuildOutput = segments.slice(0, -1).some((segment) => buildOutputDirectories.has(segment));
      files.push(describeFile(absolute, path, underBuildOutput));
    }
  };
  walk(root, 0);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function describeFile(absolute: string, path: string, underBuildOutput: boolean): InspectedFile {
  const role = classifyRole(path);
  const bytes = safeSize(absolute);
  const shouldRead = bytes <= maximumFileCharacters * 4 && (role === "source" || role === "test" || role === "config" || role === "doc");
  const content = shouldRead ? readFileSafely(absolute) : null;
  return {
    path,
    role,
    underBuildOutput,
    bytes,
    lines: content === null ? null : countLines(content),
    sha256: content === null ? null : createHash("sha256").update(content).digest("hex").slice(0, 16),
  };
}

function classifyRole(path: string): InspectedFileRole {
  const name = path.split("/").pop() ?? path;
  const extension = name.includes(".") ? `.${name.split(".").pop()}` : "";
  if (/(^|\/)(tests?|__tests__|spec|specs|e2e)\//i.test(path) || /\.(test|spec)\.[a-z]+$/i.test(name)) {
    return "test";
  }
  if (configFileNames.has(name) || /\.(config|rc)\.[a-z]+$/i.test(name) || /^tsconfig(\..+)?\.json$/i.test(name)) {
    return "config";
  }
  if (extension === ".md" || extension === ".txt" || extension === ".rst") {
    return "doc";
  }
  if (sourceExtensions.has(extension)) {
    return "source";
  }
  return "other";
}

function summarizeTotals(files: readonly InspectedFile[]): ArtifactInspection["totals"] {
  const hand = files.filter((file) => !file.underBuildOutput);
  const sum = (role: InspectedFileRole): number =>
    hand.filter((file) => file.role === role).reduce((total, file) => total + (file.lines ?? 0), 0);
  return {
    files: hand.length,
    buildOutputFiles: files.length - hand.length,
    sourceFiles: hand.filter((file) => file.role === "source").length,
    testFiles: hand.filter((file) => file.role === "test").length,
    sourceLines: sum("source"),
    testLines: sum("test"),
  };
}

/**
 * Resolves every entry point the manifest advertises. A package whose `main`
 * points at a path the build never emits still passes a test suite that imports
 * by relative path, so this check catches a real defect that green tests hide.
 */
function checkEntryPoints(root: string, manifest: Record<string, unknown>): EntryPointCheck[] {
  const checks: EntryPointCheck[] = [];
  const record = (field: string, declared: unknown): void => {
    if (typeof declared !== "string" || !declared.trim()) {
      return;
    }
    const resolvedPath = resolveEntryPoint(root, declared);
    checks.push({ field, declared, resolvedPath, exists: resolvedPath !== null });
  };
  for (const field of ["main", "module", "types", "typings", "browser"]) {
    record(field, manifest[field]);
  }
  const bin = manifest.bin;
  if (typeof bin === "string") {
    record("bin", bin);
  } else if (isRecord(bin)) {
    for (const [name, target] of Object.entries(bin)) {
      record(`bin.${name}`, target);
    }
  }
  const exported = manifest.exports;
  if (typeof exported === "string") {
    record("exports", exported);
  } else if (isRecord(exported)) {
    for (const [name, target] of Object.entries(exported)) {
      if (typeof target === "string") {
        record(`exports["${name}"]`, target);
      } else if (isRecord(target)) {
        for (const [condition, conditional] of Object.entries(target)) {
          record(`exports["${name}"].${condition}`, conditional);
        }
      }
    }
  }
  return checks;
}

function resolveEntryPoint(root: string, declared: string): string | null {
  const base = declared.replace(/^\.\//, "");
  const candidates = [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, `${base}.d.ts`, join(base, "index.js")];
  for (const candidate of candidates) {
    const absolute = join(root, candidate);
    if (existsSync(absolute) && safeIsFile(absolute)) {
      return toPosix(relative(root, absolute));
    }
  }
  return null;
}

/**
 * Compares every declared dependency range against what is actually installed
 * in `node_modules`. A workspace whose validation command passes against
 * packages its own manifest does not allow is not reproducible, and that gap is
 * invisible in both the diff and the test output.
 */
function detectDependencyDrift(root: string, manifest: Record<string, unknown>): DependencyDrift[] {
  const drift: DependencyDrift[] = [];
  for (const scope of ["dependencies", "devDependencies"] as const) {
    const declared = manifest[scope];
    if (!isRecord(declared)) {
      continue;
    }
    for (const [name, range] of Object.entries(declared)) {
      if (typeof range !== "string") {
        continue;
      }
      const installedManifest = parseJsonRecord(readFileSafely(join(root, "node_modules", ...name.split("/"), "package.json")));
      const installed = typeof installedManifest?.version === "string" ? installedManifest.version : null;
      drift.push({
        name,
        scope,
        declared: range,
        installed,
        satisfied: installed === null ? null : satisfiesRange(installed, range),
        installedIsPrerelease: installed === null ? false : installed.includes("-"),
      });
    }
  }
  return drift;
}

/** Declared-range check covering the comparator forms npm manifests actually use. */
export function satisfiesRange(version: string, range: string): boolean | null {
  const trimmed = range.trim();
  if (!trimmed || trimmed === "*" || trimmed === "x" || trimmed === "latest") {
    return true;
  }
  if (/\s|\|\|/.test(trimmed) || /^(npm|file|git|github|link|workspace):/i.test(trimmed)) {
    return null;
  }
  const installed = parseVersion(version);
  if (!installed) {
    return null;
  }
  const match = /^(\^|~|>=|<=|>|<|=|v)?\s*(.+)$/.exec(trimmed);
  const operator = match?.[1] === "v" ? "" : match?.[1] ?? "";
  const target = parseVersion((match?.[2] ?? "").replace(/^v/, ""));
  if (!target) {
    return null;
  }
  // npm only matches a prerelease build when the comparator names that same core release.
  if (installed.prerelease && !(target.prerelease && sameCore(installed, target))) {
    return false;
  }
  const order = compareCore(installed, target);
  switch (operator) {
    case "":
    case "=":
      return order === 0;
    case ">":
      return order > 0;
    case ">=":
      return order >= 0;
    case "<":
      return order < 0;
    case "<=":
      return order <= 0;
    case "~":
      return order >= 0 && installed.major === target.major && installed.minor === target.minor;
    case "^":
      if (order < 0) {
        return false;
      }
      if (target.major > 0) {
        return installed.major === target.major;
      }
      if (target.minor > 0) {
        return installed.major === 0 && installed.minor === target.minor;
      }
      return installed.major === 0 && installed.minor === 0 && installed.patch === target.patch;
    default:
      return null;
  }
}

interface ParsedVersion { major: number; minor: number; patch: number; prerelease: string | null }

function parseVersion(value: string): ParsedVersion | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(value.trim());
  if (!match) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

function sameCore(left: ParsedVersion, right: ParsedVersion): boolean {
  return left.major === right.major && left.minor === right.minor && left.patch === right.patch;
}

function compareCore(left: ParsedVersion, right: ParsedVersion): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

/** A lightweight export surface, so divergent public APIs are comparable across candidates. */
function collectExports(root: string, files: readonly InspectedFile[]): ExportedSymbol[] {
  const pattern = /^export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;
  const symbols: ExportedSymbol[] = [];
  for (const file of files) {
    if (file.role !== "source") {
      continue;
    }
    const content = readFileSafely(join(root, file.path));
    if (content === null) {
      continue;
    }
    for (const match of content.matchAll(pattern)) {
      symbols.push({ file: file.path, kind: match[1] as ExportedSymbol["kind"], symbol: match[2] });
    }
  }
  return symbols;
}

function readSources(root: string, files: readonly InspectedFile[]): ArtifactSourceFile[] {
  const sources: ArtifactSourceFile[] = [];
  let used = 0;
  for (const file of [...files].sort((left, right) => reviewOrder(left.role) - reviewOrder(right.role) || left.path.localeCompare(right.path))) {
    if (used >= maximumTotalSourceCharacters) {
      break;
    }
    const raw = readFileSafely(join(root, file.path));
    if (raw === null) {
      continue;
    }
    const truncated = raw.length > maximumFileCharacters;
    const content = truncated ? `${raw.slice(0, maximumFileCharacters)}\n[truncated]` : raw;
    used += content.length;
    sources.push({ path: file.path, role: file.role, lines: countLines(content), truncated, content });
  }
  return sources;
}

function unavailableInspection(root: string, capturedAt: string, reason: string): ArtifactInspection {
  return {
    schemaVersion: 1,
    capturedAt,
    root,
    available: false,
    reason,
    files: [],
    totals: { files: 0, buildOutputFiles: 0, sourceFiles: 0, testFiles: 0, sourceLines: 0, testLines: 0 },
    manifest: null,
    entryPoints: [],
    dependencyDrift: [],
    testFilesUnderBuildOutput: [],
    exports: [],
    sources: [],
  };
}

function countLines(content: string): number {
  if (content === "") {
    return 0;
  }
  return content.endsWith("\n") ? content.split("\n").length - 1 : content.split("\n").length;
}

function readFileSafely(absolute: string): string | null {
  try {
    return readFileSync(absolute, "utf8");
  } catch {
    return null;
  }
}

function safeSize(absolute: string): number {
  try {
    return statSync(absolute).size;
  } catch {
    return 0;
  }
}

function safeIsFile(absolute: string): boolean {
  try {
    return statSync(absolute).isFile();
  } catch {
    return false;
  }
}

function parseJsonRecord(value: string | null): Record<string, unknown> | null {
  if (value === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function toPosix(value: string): string {
  return value.split("\\").join("/");
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
