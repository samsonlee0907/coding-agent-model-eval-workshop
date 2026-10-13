import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { defineTool } from "@github/copilot-sdk";
import { z } from "zod";
import { atomicWrite } from "./durable.js";
import type { ExecutionPolicy } from "./types.js";

export const exactContentToolName = "write_file_exact";
const maxContentBytes = 1024 * 1024;
const requestSchema = z.object({
  path: z.string().min(1).max(4096),
  content: z.string().max(maxContentBytes),
}).strict();

export function assertExactContentPolicy(execution: Pick<ExecutionPolicy, "tools" | "exactContentEdits">): void {
  if (execution.exactContentEdits && !execution.tools.includes("edit")) {
    throw new TypeError("execution.exactContentEdits requires the edit capability; no shell or read-only widening is permitted.");
  }
}

export function exactUtf8Bytes(content: string): Buffer {
  const bytes = Buffer.from(content, "utf8");
  if (bytes.length > maxContentBytes) throw new RangeError("Exact-content write exceeds the 1 MiB UTF-8 byte bound.");
  if (bytes.toString("utf8") !== content) throw new TypeError("Exact-content writes require valid Unicode text without unpaired surrogates.");
  return bytes;
}

export function exactContentTool(workspace: string) {
  const root = realpathSync(workspace);
  return defineTool(exactContentToolName, {
    description: "Create or replace a workspace-relative file with exactly the supplied UTF-8 content. No newline or BOM is added; empty content is allowed. Use for byte-exact text, including removal of a terminal newline. No commands, host paths or binary encoding.",
    parameters: z.toJSONSchema(requestSchema),
    defer: "never",
    handler(input) {
      const request = requestSchema.parse(input);
      const parts = request.path.split(/[\\/]/);
      if (isAbsolute(request.path) || /[:\0]/.test(request.path) || parts.some((part) =>
        !part || part === "." || part === ".." || /[. ]$/.test(part)
        || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
        || [".git", "node_modules", ".benchmark-artifacts", ".benchmark-runs"].includes(part.toLowerCase()))) {
        throw new TypeError("Exact-content writes require a workspace-relative file path without traversal, reserved names or toolkit metadata.");
      }
      const bytes = exactUtf8Bytes(request.content);
      let path = root;
      for (const [index, part] of parts.entries()) {
        path = join(path, part);
        const stat = lstatSync(path, { throwIfNoEntry: false });
        if (stat && (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory()))) {
          throw new TypeError("Exact-content writes reject symlinks/junctions and nonregular file paths.");
        }
      }
      // Replacing rather than truncating also avoids writing through an existing hardlink.
      atomicWrite(path, bytes);
      return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    },
  });
}
