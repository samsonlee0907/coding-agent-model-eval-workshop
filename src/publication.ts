import { createHash, randomUUID } from "node:crypto";
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import sanitizeHtml from "sanitize-html";
import { zipSync, strToU8 } from "fflate";
import { z } from "zod";
import { atomicWrite } from "./durable.js";
import { parseReportEvidence, selectReportCells, sha256Schema, taskTypeAnalysis, type ReportEvidence } from "./evidence.js";
import { renderEvidenceReport } from "./report-ui.js";

export const publicationManifestSchema = z.object({
  schemaVersion: z.literal(1),
  roots: z.record(z.string(), z.string()),
  entries: z.array(z.object({
    id: z.string().regex(/^[a-zA-Z0-9_-]+$/), title: z.string().min(1).max(200),
    task: z.string().min(1), attempt: z.string().optional(), role: z.enum(["source", "output"]),
    root: z.string(), path: z.string(), sha256: sha256Schema,
    kind: z.enum(["text", "json", "csv", "html", "image", "pdf", "workbook-cached"]),
    allowOriginalDownload: z.boolean().default(false),
  }).strict()).max(100),
}).strict();
export type PublicationManifest = z.infer<typeof publicationManifestSchema>;
export type ApprovedPreview = {
  id: string; title: string; task: string; attempt?: string; role: "source" | "output";
  kind: PublicationManifest["entries"][number]["kind"]; status: "available" | "oversized" | "invalid" | "unsupported";
  sha256: string; bytes: number; content: string | null; reason: string | null; download?: string;
};

export function safeRelativePath(root: string, path: string): string {
  if (!path || isAbsolute(path) || /^[a-z]:/i.test(path) || path.includes("\0")
      || path.split(/[\\/]/).some((part) => !part || part === "." || part === "..")
      || /[:]/.test(path)) throw new TypeError("Absolute, traversal, empty or alternate-stream artifact path.");
  const resolvedRoot = realpathSync(root);
  let current = resolvedRoot;
  for (const part of path.split(/[\\/]/)) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new TypeError("Artifact symlinks/junctions are forbidden.");
  }
  const actual = realpathSync(current);
  const rel = relative(resolvedRoot, actual);
  if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel) || !lstatSync(actual).isFile()) throw new TypeError("Artifact escapes its approved root or is not a regular file.");
  return actual;
}

export function prepareApprovedPreviews(
  input: unknown, evidence: ReportEvidence,
): { previews: ApprovedPreview[]; originals: Map<string, Uint8Array> } {
  const manifest = publicationManifestSchema.parse(input);
  const ids = new Set<string>();
  let total = 0;
  const originals = new Map<string, Uint8Array>();
  const previews = manifest.entries.map((entry): ApprovedPreview => {
    if (ids.has(entry.id)) throw new TypeError("Duplicate publication entry ID.");
    ids.add(entry.id);
    if (!evidence.tasks.some((t) => t.id === entry.task)) throw new TypeError("Publication entry is not bound to a declared task.");
    if (entry.role === "output" && !entry.attempt) throw new TypeError("Output previews require an exact attempt binding.");
    if (entry.attempt && !evidence.attempts.some((a) => a.id === entry.attempt && a.task === entry.task)) throw new TypeError("Publication attempt binding mismatch.");
    const root = manifest.roots[entry.root];
    if (!root) throw new TypeError("Unknown approved publication root.");
    const path = safeRelativePath(resolve(root), entry.path);
    const bytes = lstatSync(path).size;
    total += bytes;
    if (total > 8 * 1024 * 1024) throw new RangeError("Approved publication exceeds 8 MiB total limit.");
    const base: ApprovedPreview = {
      id: entry.id, title: entry.title, task: entry.task, attempt: entry.attempt, role: entry.role, kind: entry.kind,
      status: "available", sha256: entry.sha256, bytes, content: null, reason: null,
    };
    if (bytes > 1024 * 1024) return { ...base, status: "oversized", reason: "Preview exceeds the 1 MiB per-file limit; not copied." };
    const content = readFileSync(path);
    if (createHash("sha256").update(content).digest("hex") !== entry.sha256) throw new TypeError("Approved publication byte/hash binding mismatch.");
    const text = content.toString("utf8");
    if (entry.kind === "image") {
      const png = content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const jpeg = content[0] === 255 && content[1] === 216 && content[2] === 255;
      const gif = /^GIF8[79]a/.test(content.subarray(0, 6).toString());
      if (!png && !jpeg && !gif) return { ...base, status: "invalid", reason: "Only signature-checked PNG, JPEG and GIF raster images are supported." };
      base.content = `data:image/${png ? "png" : jpeg ? "jpeg" : "gif"};base64,${content.toString("base64")}`;
    } else if (entry.kind === "pdf") {
      if (!text.startsWith("%PDF-")) return { ...base, status: "invalid", reason: "Invalid PDF signature." };
      base.status = "unsupported";
      base.reason = "PDF rendering/OCR is unavailable. Supply a separately approved raster preview.";
    } else if (entry.kind === "html") {
      const sanitized = sanitizeHtml(text, {
        allowedTags: ["h1", "h2", "h3", "h4", "p", "br", "hr", "strong", "em", "b", "i", "ul", "ol", "li", "pre", "code", "table", "thead", "tbody", "tr", "th", "td", "div", "span", "blockquote"],
        allowedAttributes: { th: ["colspan", "rowspan", "scope"], td: ["colspan", "rowspan"] },
        allowedSchemes: [], allowProtocolRelative: false,
      });
      base.content = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>body{font:15px system-ui;padding:20px;overflow-wrap:anywhere}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:8px}pre{white-space:pre-wrap}</style>${sanitized}`;
    } else if (entry.kind === "json") {
      try { base.content = JSON.stringify(JSON.parse(text), null, 2); }
      catch { return { ...base, status: "invalid", reason: "Invalid JSON; no reconstructed output." }; }
    } else {
      if (content.includes(0) || text.includes("\uFFFD")) return { ...base, status: "invalid", reason: "Binary or invalid UTF-8 content cannot be previewed as text." };
      const lines = text.split(/\r?\n/);
      base.content = lines.slice(0, 500).join("\n");
      if (lines.length > 500) base.reason = "Truncated at 500 lines; the recorded hash describes the original bytes.";
      if (entry.kind === "workbook-cached") base.reason = "User-supplied cached/formula representation; values were not recalculated or independently extracted.";
    }
    if (entry.allowOriginalDownload) {
      const extension = entry.kind === "image" ? "raster" : entry.kind === "html" ? "html" : entry.kind === "pdf" ? "pdf" : "txt";
      base.download = `artifacts/${entry.id}-${entry.sha256.slice(0, 16)}.${extension}`;
      originals.set(base.download, content);
    }
    return base;
  });
  return { previews, originals };
}

export function spreadsheetSafe(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /^[\s]*[=+\-@]|^[\t\r\n]/.test(text) ? `'${text}` : text;
}

export function toCsv(rows: readonly Record<string, unknown>[], columns: readonly string[]): string {
  const quote = (value: unknown) => `"${spreadsheetSafe(value).replaceAll('"', '""')}"`;
  return `${[columns.map(quote).join(","), ...rows.map((row) => columns.map((column) => quote(row[column])).join(","))].join("\r\n")}\r\n`;
}

export function selectedResultRows(evidence: ReportEvidence) {
  return selectReportCells(evidence).map((cell) => ({
    task: cell.task, candidate: cell.candidate, repeat: cell.repeat, status: cell.status,
    runId: cell.selected?.id ?? null, selectionReason: cell.reason, attempts: cell.attempts.length,
    validation: cell.selected?.validation ?? null, requiredFailed: cell.selected?.requiredFailed ?? null,
    advisoryFailed: cell.selected?.advisoryFailed ?? null, checkErrors: cell.selected?.checkErrors ?? null,
    wallMs: cell.selected?.metrics.wallMs ?? null, inputTokens: cell.selected?.metrics.inputTokens ?? null,
    outputTokens: cell.selected?.metrics.outputTokens ?? null, recordedUsd: cell.selected?.metrics.recordedUsd ?? null,
    recordedCostMultiplier: cell.selected?.metrics.recordedCost ?? null,
    allAttemptRecordedCostMultiplier: cell.attempts.length && cell.attempts.every((a) => a.metrics.recordedCost !== null)
      ? cell.attempts.reduce((sum, a) => sum + a.metrics.recordedCost!, 0) : null,
    contractHash: cell.selected?.contractHash ?? null, promptHash: cell.selected?.promptHash ?? null,
    policyHash: cell.selected?.policyHash ?? null, workspaceHash: cell.selected?.workspaceHash ?? null,
  }));
}

export function writeReportBundle(input: ReportEvidence, output: string, options: { publication?: unknown; zip?: boolean; details?: string } = {}): string {
  const evidence = parseReportEvidence(input);
  const target = resolve(output);
  if (existsSync(target) || (options.zip && existsSync(`${target}.zip`))) throw new Error("Report output exists; choose a new versioned destination. Existing reports are never overwritten.");
  mkdirSync(dirname(target), { recursive: true });
  const stage = `${target}.stage-${randomUUID()}`;
  const stagedZip = `${stage}.zip`;
  mkdirSync(stage);
  try {
    const approved = options.publication ? prepareApprovedPreviews(options.publication, evidence) : { previews: [], originals: new Map<string, Uint8Array>() };
    const selected = selectedResultRows(evidence);
    const analysis = taskTypeAnalysis(evidence);
    const files = new Map<string, Uint8Array>([
      ["index.html", strToU8(renderEvidenceReport(evidence, approved.previews, options.details))],
      ["evidence.json", strToU8(`${JSON.stringify(evidence, null, 2)}\n`)],
      ["selected-results.json", strToU8(`${JSON.stringify(selected, null, 2)}\n`)],
      ["selected-results.csv", strToU8(toCsv(selected, Object.keys(selected[0] ?? { task: "", candidate: "", status: "" })))],
      ["task-types.json", strToU8(`${JSON.stringify(analysis, null, 2)}\n`)],
      ["task-types.csv", strToU8(toCsv(analysis, Object.keys(analysis[0] ?? { taskType: "", samples: "" })))],
      ["previews.json", strToU8(`${JSON.stringify(approved.previews, null, 2)}\n`)],
      ...approved.originals,
    ]);
    const integrity = [...files].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }));
    files.set("integrity.json", strToU8(JSON.stringify({ schemaVersion: 1, cells: selected.length, files: integrity }, null, 2)));
    if ([...files.values()].reduce((sum, bytes) => sum + bytes.length, 0) > 64 * 1024 * 1024) throw new RangeError("Portable report exceeds the 64 MiB publication byte bound.");
    for (const [path, bytes] of files) {
      mkdirSync(dirname(join(stage, path)), { recursive: true });
      writeFileSync(join(stage, path), bytes);
    }
    verifyReportBundle(stage);
    if (options.zip) atomicWrite(stagedZip, zipSync(Object.fromEntries(files), { level: 6 }));
    renameSync(stage, target);
    if (options.zip) linkSync(stagedZip, `${target}.zip`);
    return join(target, "index.html");
  } finally {
    if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
    if (existsSync(stagedZip)) rmSync(stagedZip);
  }
}

export function verifyReportBundle(directory: string): void {
  const integrity = z.object({
    schemaVersion: z.literal(1), cells: z.number().int().nonnegative(),
    files: z.array(z.object({ path: z.string(), bytes: z.number().int().nonnegative(), sha256: sha256Schema })),
  }).parse(JSON.parse(readFileSync(join(directory, "integrity.json"), "utf8")));
  for (const file of integrity.files) {
    const bytes = readFileSync(safeRelativePath(directory, file.path));
    if (bytes.length !== file.bytes || createHash("sha256").update(bytes).digest("hex") !== file.sha256) throw new Error(`Publication integrity verification failed for ${file.path}.`);
  }
  const evidence = parseReportEvidence(JSON.parse(readFileSync(join(directory, "evidence.json"), "utf8")));
  const selected = JSON.parse(readFileSync(join(directory, "selected-results.json"), "utf8"));
  if (selectReportCells(evidence).length !== integrity.cells || JSON.stringify(selected) !== JSON.stringify(selectedResultRows(evidence))) throw new Error("Publication coverage/selection mismatch.");
  const previews: ApprovedPreview[] = JSON.parse(readFileSync(join(directory, "previews.json"), "utf8"));
  for (const preview of previews) if (preview.download && !integrity.files.some((f) => f.path === preview.download)) throw new Error("Missing approved download.");
}
