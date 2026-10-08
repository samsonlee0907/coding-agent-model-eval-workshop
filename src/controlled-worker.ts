import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { defineTool, type Tool } from "@github/copilot-sdk";
import { z } from "zod";
import { atomicJson } from "./durable.js";
import { evidenceHash } from "./evidence.js";
import { safeRelativePath } from "./publication.js";
import type { BenchmarkConfig, ToolCapability, ValidationResult } from "./types.js";

export const isolationSchema = z.object({
  mode: z.literal("container"),
  image: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/:-]*@sha256:[a-f0-9]{64}$/),
  memoryMb: z.number().int().min(128), cpus: z.number().positive().max(64),
  maxFiles: z.number().int().min(1).max(100000), maxBytes: z.number().int().positive().max(512 * 1024 * 1024),
  commandTimeoutMs: z.number().int().positive().max(3600000),
}).strict();
type Isolation = z.infer<typeof isolationSchema>;
export type SnapshotFile = { path: string; bytes: number; sha256: string; content: string };
const filesSchema = z.array(z.object({ path: z.string(), bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/), content: z.string() }).strict());
const omitted = new Set([".git", "node_modules", ".benchmark-artifacts", ".benchmark-runs"]);

export function collectSnapshot(root: string, maxFiles: number, maxBytes: number): SnapshotFile[] {
  const files: SnapshotFile[] = [];
  let bytes = 0;
  const walk = (directory: string, prefix: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (omitted.has(entry.name)) continue;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const actual = join(directory, entry.name);
      if (lstatSync(actual).isSymbolicLink()) throw new TypeError(`Input snapshot rejects symlinks/junctions: ${path}`);
      if (entry.isDirectory()) walk(actual, path);
      else if (entry.isFile()) {
        const size = lstatSync(actual).size;
        bytes += size;
        if (bytes > maxBytes || files.length >= maxFiles) throw new RangeError("Input snapshot exceeds file/byte bounds.");
        const content = readFileSync(safeRelativePath(root, path));
        files.push({ path, bytes: content.length, sha256: createHash("sha256").update(content).digest("hex"), content: content.toString("base64") });
      } else throw new TypeError("Input snapshot contains a non-regular file.");
    }
  };
  walk(root, "");
  return files;
}

export function validateSnapshot(value: unknown, maxFiles: number, maxBytes: number): SnapshotFile[] {
  const files = filesSchema.parse(value);
  let bytes = 0;
  const seen = new Set<string>();
  const segments = new Map<string, string>();
  for (const file of files) {
    if (!file.path || file.path.includes("\\") || /[:\0]/.test(file.path) || file.path.startsWith("/")
        || file.path.split("/").some((part) => !part || part === "." || part === ".." || omitted.has(part)
          || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new TypeError("Unsafe exported snapshot path.");
    let prefix = "";
    for (const part of file.path.split("/")) {
      prefix += `/${part}`;
      const prior = segments.get(prefix.toLowerCase());
      if (prior && prior !== prefix) throw new TypeError("Case-colliding snapshot directories.");
      segments.set(prefix.toLowerCase(), prefix);
    }
    const key = file.path.toLowerCase();
    if (seen.has(key)) throw new TypeError("Duplicate/case-colliding snapshot path.");
    seen.add(key);
    const content = Buffer.from(file.content, "base64");
    if (content.toString("base64") !== file.content || content.length !== file.bytes
        || createHash("sha256").update(content).digest("hex") !== file.sha256) throw new TypeError("Snapshot byte/hash binding mismatch.");
    bytes += content.length;
  }
  if (files.length > maxFiles || bytes > maxBytes) throw new RangeError("Exported snapshot exceeds file/byte bounds.");
  return files;
}

export function snapshotHash(files: readonly SnapshotFile[]): string {
  return evidenceHash(files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })).sort((a, b) => a.path.localeCompare(b.path)));
}

export function writeSnapshot(root: string, input: unknown, maxFiles: number, maxBytes: number): string {
  const files = validateSnapshot(input, maxFiles, maxBytes);
  if (existsSync(root)) throw new Error("Snapshot destination exists; refusing to overwrite.");
  const stage = `${root}.stage-${randomUUID()}`;
  mkdirSync(stage, { recursive: true });
  try {
    for (const file of files) {
      const path = join(stage, ...file.path.split("/"));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, Buffer.from(file.content, "base64"), { flag: "wx", mode: 0o600 });
    }
    renameSync(stage, root);
  } finally {
    if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
  }
  return snapshotHash(files);
}

export type DockerResult = { code: number; stdout: string; stderr: string };
export type DockerExecutor = (args: readonly string[], input?: string, timeoutMs?: number, maxBytes?: number) => Promise<DockerResult>;
export const executeDocker: DockerExecutor = (args, input, timeoutMs = 30000, maxBytes = 65536) => new Promise((resolve, reject) => {
  const child = spawn("docker", [...args], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  let size = 0, failure: Error | null = null;
  const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
    size += chunk.length;
    if (size > maxBytes) { failure = new RangeError("Docker command output exceeds its byte bound."); child.kill(); }
    else chunks.push(chunk);
  };
  const timer = setTimeout(() => { failure = new Error("Docker command deadline exceeded."); child.kill(); }, timeoutMs);
  child.stdout.on("data", collect(stdout)); child.stderr.on("data", collect(stderr));
  child.once("error", (error) => { clearTimeout(timer); reject(error); });
  child.once("close", (code) => {
    clearTimeout(timer);
    if (failure) reject(failure);
    else resolve({ code: code ?? 1, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() });
  });
  child.stdin.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE") failure = error; });
  child.stdin.end(input);
});

export function controlledContainerArgs(policy: Isolation, name: string, volume: string, owner: string): string[] {
  return ["run", "-d", "--pull", "never", "--name", name, "--label", `benchmark.owner=${owner}`,
    "--network", "none", "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--read-only", "--pids-limit", "128", "--memory", `${policy.memoryMb}m`, "--memory-swap", `${policy.memoryMb}m`,
    "--cpus", String(policy.cpus), "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m,uid=1000,gid=1000",
    "--tmpfs", `/grader:rw,noexec,nosuid,size=${policy.maxBytes},uid=1000,gid=1000`,
    "--mount", `type=volume,source=${volume},target=/workspace`, "--workdir", "/workspace",
    "--entrypoint", "/usr/local/bin/node", policy.image, "-e", "setInterval(()=>{},1000000)"];
}

const importScript = `
const fs=require("node:fs"),path=require("node:path");let text="";process.stdin.on("data",c=>text+=c);process.stdin.on("end",()=>{
for(const f of JSON.parse(text)){const p=path.join(process.argv[1],f.path);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,Buffer.from(f.content,"base64"),{flag:"wx"});}
});`;
const exportScript = `
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const files=[];let bytes=0;const [maxFiles,maxBytes]=process.argv.slice(1).map(Number);
function walk(dir,prefix){for(const name of fs.readdirSync(dir).sort()){if([".git","node_modules",".benchmark-artifacts",".benchmark-runs"].includes(name))continue;const p=path.join(dir,name),rel=prefix?prefix+"/"+name:name,s=fs.lstatSync(p);if(s.isSymbolicLink())throw Error("Export rejects symlinks");if(s.isDirectory())walk(p,rel);else if(s.isFile()){bytes+=s.size;if(bytes>maxBytes||files.length>=maxFiles)throw Error("Export file/byte bound exceeded");const b=fs.readFileSync(p);files.push({path:rel,bytes:b.length,sha256:crypto.createHash("sha256").update(b).digest("hex"),content:b.toString("base64")});}else throw Error("Nonregular export");}}
walk("/workspace","");process.stdout.write(JSON.stringify(files));`;

const workspaceToolSchema = z.object({
  operation: z.enum(["read", "write", "list", "command"]),
  path: z.string().optional(), content: z.string().max(1024 * 1024).optional(),
  command: z.string().max(20000).optional(),
}).strict();

export class ControlledWorker {
  private sealed = false;
  private closed = false;
  private readonly name: string;
  private readonly volume: string;
  private readonly owner: string;
  private constructor(
    private readonly policy: Isolation, private readonly recordPath: string,
    private readonly docker: DockerExecutor, identity?: { name: string; volume: string; owner: string },
    private readonly deadlineAt = Infinity,
  ) {
    this.owner = identity?.owner ?? randomUUID();
    this.name = identity?.name ?? `benchmark-${this.owner}`;
    this.volume = identity?.volume ?? `${this.name}-workspace`;
  }
  static async create(policy: BenchmarkConfig["isolation"], files: SnapshotFile[], recordPath: string, docker = executeDocker, graderFiles?: SnapshotFile[], deadlineAt?: number): Promise<ControlledWorker> {
    const worker = new ControlledWorker(isolationSchema.parse(policy), recordPath, docker, undefined, deadlineAt);
    await worker.checked(["version", "--format", "{{.Server.Version}}"]);
    await worker.checked(["image", "inspect", worker.policy.image]);
    atomicJson(recordPath, { schemaVersion: 1, policy: worker.policy, name: worker.name, volume: worker.volume, owner: worker.owner });
    try {
      await worker.checked(["volume", "create", "--label", `benchmark.owner=${worker.owner}`, worker.volume]);
      // Credential-free initialization only changes its own Docker-managed volume.
      await worker.checked(["run", "--rm", "--pull", "never", "--name", `${worker.name}-init`, "--label", `benchmark.owner=${worker.owner}`,
        "--network", "none", "--cap-drop", "ALL", "--pids-limit", "16", "--memory", "128m", "--cpus", "0.5",
        "--security-opt", "no-new-privileges", "--user", "0", "--read-only",
        "--mount", `type=volume,source=${worker.volume},target=/workspace`, "--entrypoint", "chmod", worker.policy.image, "0777", "/workspace"]);
      await worker.checked(controlledContainerArgs(worker.policy, worker.name, worker.volume, worker.owner));
      await worker.checked(["exec", "-i", worker.name, "/usr/local/bin/node", "-e", importScript, "/workspace"],
        JSON.stringify(validateSnapshot(files, worker.policy.maxFiles, worker.policy.maxBytes)), worker.policy.maxBytes * 2 + 65536);
      if (graderFiles) await worker.checked(["exec", "-i", worker.name, "/usr/local/bin/node", "-e", importScript, "/grader"],
        JSON.stringify(validateSnapshot(graderFiles, worker.policy.maxFiles, worker.policy.maxBytes)), worker.policy.maxBytes * 2 + 65536);
      return worker;
    } catch (error) {
      try { await ControlledWorker.cleanup(recordPath, docker); }
      catch (cleanup) { throw new AggregateError([error, cleanup], `Controlled worker creation and cleanup failed; retain ownership record ${recordPath}.`); }
      throw error;
    }
  }
  static async reopen(recordPath: string, docker = executeDocker, deadlineAt?: number): Promise<ControlledWorker> {
    const record = z.object({
      schemaVersion: z.literal(1), policy: isolationSchema,
      name: z.string().regex(/^benchmark-[a-f0-9-]+$/), volume: z.string().regex(/^benchmark-[a-f0-9-]+-workspace$/), owner: z.string().uuid(),
    }).parse(JSON.parse(readFileSync(recordPath, "utf8")));
    const worker = new ControlledWorker(record.policy, recordPath, docker, record, deadlineAt);
    if (record.name !== `benchmark-${record.owner}` || record.volume !== `${record.name}-workspace`) throw new TypeError("Worker ownership record name binding mismatch.");
    await worker.verifyOwner();
    const state = await worker.checked(["inspect", "--format", "{{json .State}}", worker.name]);
    const status = z.object({ Running: z.boolean(), Paused: z.boolean() }).passthrough().parse(JSON.parse(state.stdout));
    if (!status.Running) await worker.checked(["start", worker.name]);
    worker.sealed = status.Paused;
    return worker;
  }
  tool(capabilities: readonly ToolCapability[]): Tool {
    return defineTool("controlled_workspace", {
      description: "Read/write/list files or run a shell command inside the network-disabled isolated task container. Paths are workspace-relative. No host access or cloud credentials.",
      parameters: z.toJSONSchema(workspaceToolSchema),
      handler: async (input) => {
        const request = workspaceToolSchema.parse(input);
        if (this.sealed || this.closed) throw new Error("Controlled workspace is sealed or stopped.");
        const capability = request.operation === "command" ? "shell" : request.operation === "write" ? "edit" : "read";
        if (!capabilities.includes(capability)) throw new Error("Task tool capability denied.");
        if (request.operation === "command") {
          if (!request.command) throw new TypeError("command is required.");
          try {
            return await this.docker(["exec", this.name, "/bin/sh", "-c", request.command], undefined, this.timeout());
          } catch (error) {
            await this.stop();
            throw error;
          }
        }
        const path = request.path ?? ".";
        if (path !== "." && (path.startsWith("/") || /[:\\\0]/.test(path) || path.split("/").some((s) => !s || s === ".."))) throw new TypeError("Use workspace-relative paths without traversal.");
        const script = `const fs=require("node:fs"),path=require("node:path");const p=path.resolve("/workspace",process.argv[1]);let current="/workspace";for(const part of path.relative(current,p).split("/")){if(!part)continue;current=path.join(current,part);if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink())throw Error("Symlink tool path denied");}const op=process.argv[2];if(op==="list")process.stdout.write(JSON.stringify(fs.readdirSync(p)));else if(op==="read"){if(fs.statSync(p).size>65536)throw Error("Read exceeds 64 KiB");process.stdout.write(fs.readFileSync(p,"utf8"));}else{let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,s);});}`;
        return this.checked(["exec", "-i", this.name, "/usr/local/bin/node", "-e", script, path, request.operation], request.content);
      },
    });
  }
  async snapshot(destination: string): Promise<string> {
    this.sealed = true;
    await this.verifyOwner();
    const paused = await this.checked(["inspect", "--format", "{{.State.Paused}}", this.name]);
    if (paused.stdout.trim() !== "true") await this.checked(["pause", this.name]);
    const exporters = await this.checked(["container", "ls", "-a", "--filter", `name=${this.name}-export`, "--format", "{{.Names}}"]);
    if (exporters.stdout.split(/\r?\n/).includes(`${this.name}-export`)) await this.removeOwnedContainer(`${this.name}-export`);
    const result = await this.checked(["run", "--rm", "--pull", "never", "--name", `${this.name}-export`,
      "--label", `benchmark.owner=${this.owner}`, "--network", "none", "--user", "1000:1000", "--read-only",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "16",
      "--memory", `${this.policy.memoryMb}m`, "--memory-swap", `${this.policy.memoryMb}m`, "--cpus", String(this.policy.cpus),
      "--mount", `type=volume,source=${this.volume},target=/workspace,readonly`,
      "--entrypoint", "/usr/local/bin/node", this.policy.image, "-e", exportScript,
      String(this.policy.maxFiles), String(this.policy.maxBytes)], undefined, this.policy.maxBytes * 2 + this.policy.maxFiles * 512);
    const files = validateSnapshot(JSON.parse(result.stdout), this.policy.maxFiles, this.policy.maxBytes);
    const hash = snapshotHash(files);
    atomicJson(`${this.recordPath}.snapshot.json`, { schemaVersion: 1, workspaceHash: hash, files });
    writeSnapshot(destination, files, this.policy.maxFiles, this.policy.maxBytes);
    return hash;
  }
  async validate(command: string, timeoutMs: number): Promise<ValidationResult> {
    const startedAt = new Date().toISOString(), started = Date.now();
    let result: DockerResult | null = null, errorMessage: string | null = null;
    try { result = await this.docker(["exec", this.name, "/bin/sh", "-c", command], undefined, Math.min(timeoutMs, this.timeout())); }
    catch (error) { errorMessage = error instanceof Error ? error.message : String(error); await this.stop(); }
    return {
      command, startedAt, completedAt: new Date().toISOString(), durationMs: Date.now() - started,
      exitCode: result?.code ?? null, timedOut: errorMessage?.includes("deadline") ?? false,
      errorMessage, stdout: result?.stdout ?? "", stderr: result?.stderr ?? "",
    };
  }
  async stop(): Promise<void> {
    await this.verifyOwner(true);
    await this.checked(["stop", "--time", "2", this.name], undefined, undefined, true);
    this.closed = true;
  }
  async dispose(): Promise<void> {
    await this.verifyOwner(true);
    await ControlledWorker.cleanup(this.recordPath, this.docker);
    this.closed = true;
  }
  static async cleanup(recordPath: string, docker = executeDocker): Promise<void> {
    const record = z.object({
      schemaVersion: z.literal(1), policy: isolationSchema, name: z.string(), volume: z.string(), owner: z.string().uuid(),
    }).strict().parse(JSON.parse(readFileSync(recordPath, "utf8")));
    if (record.name !== `benchmark-${record.owner}` || record.volume !== `${record.name}-workspace`) throw new TypeError("Worker ownership record name binding mismatch.");
    const worker = new ControlledWorker(record.policy, recordPath, docker, record, Date.now() + 30000);
    const containers = await worker.checked(["container", "ls", "-a", "--filter", `name=${record.name}`, "--format", "{{.Names}}"]);
    for (const name of [`${record.name}-init`, `${record.name}-export`, record.name]) {
      if (!containers.stdout.split(/\r?\n/).includes(name)) continue;
      await worker.removeOwnedContainer(name);
    }
    const volumes = await worker.checked(["volume", "ls", "--filter", `name=${record.volume}`, "--format", "{{.Name}}"]);
    if (volumes.stdout.split(/\r?\n/).includes(record.volume)) {
      const label = await worker.checked(["volume", "inspect", "--format", '{{index .Labels "benchmark.owner"}}', record.volume]);
      if (label.stdout.trim() !== record.owner) throw new Error("Volume ownership mismatch; cleanup denied.");
      await worker.checked(["volume", "rm", record.volume]);
    }
  }
  private async verifyOwner(cleanup = false): Promise<void> {
    const result = await this.checked(["inspect", "--format", '{{index .Config.Labels "benchmark.owner"}}', this.name], undefined, undefined, cleanup);
    if (result.stdout.trim() !== this.owner) throw new Error("Container ownership mismatch; operation denied.");
  }
  private async removeOwnedContainer(name: string): Promise<void> {
    const label = await this.checked(["inspect", "--format", '{{index .Config.Labels "benchmark.owner"}}', name]);
    if (label.stdout.trim() !== this.owner) throw new Error("Container ownership mismatch; cleanup denied.");
    await this.checked(["rm", "-f", name]);
  }
  private timeout(): number {
    if (Date.now() >= this.deadlineAt) throw new Error("Controlled worker absolute deadline exceeded.");
    return Math.max(1, Math.min(this.policy.commandTimeoutMs, this.deadlineAt - Date.now()));
  }
  private async checked(args: readonly string[], input?: string, maxBytes?: number, cleanup = false): Promise<DockerResult> {
    const result = await this.docker(args, input, cleanup ? Math.min(30000, this.policy.commandTimeoutMs) : this.timeout(), maxBytes);
    if (result.code !== 0) throw new Error(`Controlled container stage ${args[0]} failed (exit ${result.code}): ${result.stderr.slice(0, 1500)}`);
    return result;
  }
}
