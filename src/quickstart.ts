import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { BenchmarkConfig, CustomProviderType, CustomProviderWireApi } from "./types.js";

const ignoredArtifactEntries = new Set([".git", "node_modules", "dist", ".benchmark-artifacts", ".benchmark-runs"]);

export interface QuickstartOptions {
  task: string;
  sourcePath?: string;
  outputDirectory?: string;
  model?: string;
  providerLabel?: string;
  providerType?: CustomProviderType;
  baseUrlEnv?: string;
  apiKeyEnv?: string;
  bearerTokenEnv?: string;
  wireApi?: CustomProviderWireApi;
  deployment?: string;
}

export interface QuickstartWorkspace {
  config: BenchmarkConfig;
  configPath: string;
  workspacePath: string;
  baselineCommitSha: string;
  containerFingerprint: string;
}

/**
 * Creates a disposable local task workspace and local-only git baseline. No
 * GitHub account, remote, or repository is involved.
 */
export function createQuickstartWorkspace(options: QuickstartOptions): QuickstartWorkspace {
  if (!options.task.trim()) {
    throw new TypeError("A non-empty --task or --task-file value is required.");
  }
  const outputDirectory = resolve(options.outputDirectory ?? join(process.cwd(), ".benchmark-runs", `quickstart-${randomUUID()}`));
  if (existsSync(outputDirectory)) {
    throw new Error(`Quickstart output directory already exists: ${outputDirectory}`);
  }
  const workspacePath = join(outputDirectory, "workspace");
  mkdirSync(workspacePath, { recursive: true });

  if (options.sourcePath) {
    copySourceArtifact(resolve(options.sourcePath), workspacePath);
  }
  writeFileSync(join(workspacePath, "BENCHMARK_TASK.md"), `${options.task.trim()}\n`, "utf8");
  const baselineCommitSha = createLocalBaselineCommit(workspacePath);
  const containerFingerprint = createLocalEnvironmentFingerprint(workspacePath);
  const config: BenchmarkConfig = {
    contract: {
      task: {
        id: `quickstart-${digest(options.task).slice(0, 12)}`,
        prompt: options.task.trim(),
        repository: {
          commitSha: baselineCommitSha,
          containerFingerprint,
        },
        validationCommand: "auto",
      },
      candidate: {
        provider: options.providerLabel ?? "custom-byok",
        model: options.model ?? "replace-with-model-id",
        deployment: options.deployment ?? "local-byok",
      },
      customProvider: {
        type: options.providerType ?? "openai",
        baseUrlEnv: options.baseUrlEnv ?? "MODEL_BASE_URL",
        apiKeyEnv: options.bearerTokenEnv ? undefined : options.apiKeyEnv ?? "MODEL_API_KEY",
        bearerTokenEnv: options.bearerTokenEnv,
        wireApi: options.wireApi ?? defaultWireApi(options.providerType),
      },
      execution: {
        instructions: [
          "You are running a local coding benchmark with no GitHub repository or remote.",
          "Read BENCHMARK_TASK.md and implement the requested application in the current workspace.",
          "An optional source artifact may already be present; inspect and use it as task input.",
          "Work autonomously: create the project if necessary, add tests and build scripts, run validation, and repair failures.",
          "Do not use network services or access paths outside this workspace.",
        ].join(" "),
        tools: ["read", "edit", "shell"],
        permissionMode: "approve-all",
        concurrency: 1,
        retries: 0,
        sessionTimeoutMs: 900_000,
        streaming: true,
        cachePolicy: "default",
      },
    },
    rounds: [
      { prompt: options.task.trim() },
      { prompt: "Run the project tests and production build. Repair all failures and complete any missing acceptance behavior." },
    ],
    workspacePath,
    artifactsDirectory: join(outputDirectory, "artifacts"),
  };
  const configPath = join(outputDirectory, "benchmark.local.json");
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return { config, configPath, workspacePath, baselineCommitSha, containerFingerprint };
}

export function parseQuickstartOptions(argv: readonly string[]): QuickstartOptions {
  const task = argumentValue(argv, "--task");
  const taskFile = argumentValue(argv, "--task-file");
  if (task && taskFile) {
    throw new TypeError("Use either --task or --task-file, not both.");
  }
  const providerType = parseProviderType(argumentValue(argv, "--provider-type"));
  const wireApi = parseWireApi(argumentValue(argv, "--wire-api"));
  const apiKeyEnv = argumentValue(argv, "--api-key-env");
  const bearerTokenEnv = argumentValue(argv, "--bearer-token-env");
  if (apiKeyEnv && bearerTokenEnv) {
    throw new TypeError("Use either --api-key-env or --bearer-token-env, not both.");
  }
  return {
    task: task ?? (taskFile ? readFileSync(resolve(taskFile), "utf8") : ""),
    sourcePath: argumentValue(argv, "--source"),
    outputDirectory: argumentValue(argv, "--output"),
    model: argumentValue(argv, "--model"),
    providerLabel: argumentValue(argv, "--provider"),
    providerType,
    baseUrlEnv: argumentValue(argv, "--base-url-env"),
    apiKeyEnv,
    bearerTokenEnv,
    wireApi,
    deployment: argumentValue(argv, "--deployment"),
  };
}

function argumentValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new TypeError(`${name} requires a value.`);
  }
  return value;
}

function parseProviderType(value: string | undefined): CustomProviderType | undefined {
  if (!value) {
    return undefined;
  }
  if (value === "openai" || value === "azure" || value === "anthropic") {
    return value;
  }
  throw new TypeError("--provider-type must be openai, azure, or anthropic.");
}

function parseWireApi(value: string | undefined): CustomProviderWireApi | undefined {
  if (!value) {
    return undefined;
  }
  if (value === "completions" || value === "responses") {
    return value;
  }
  throw new TypeError("--wire-api must be completions or responses.");
}

function defaultWireApi(providerType: CustomProviderType | undefined): CustomProviderWireApi | undefined {
  return providerType === "anthropic" ? undefined : "completions";
}

function copySourceArtifact(sourcePath: string, workspacePath: string): void {
  if (!existsSync(sourcePath)) {
    throw new Error(`Source artifact does not exist: ${sourcePath}`);
  }
  if (lstatSync(sourcePath).isDirectory()) {
    cpSync(sourcePath, workspacePath, {
      recursive: true,
      filter: (entry) => !ignoredArtifactEntries.has(entry.split(/[\\/]/).at(-1) ?? ""),
    });
    return;
  }
  const sourceDirectory = join(workspacePath, "source-artifact");
  mkdirSync(sourceDirectory, { recursive: true });
  cpSync(sourcePath, join(sourceDirectory, sourcePath.split(/[\\/]/).at(-1) ?? "artifact"));
}

function createLocalBaselineCommit(workspacePath: string): string {
  executeGit(["init", "-b", "main"], workspacePath);
  executeGit(["config", "user.name", "Benchmark Harness"], workspacePath);
  executeGit(["config", "user.email", "benchmark-harness@localhost"], workspacePath);
  executeGit(["add", "--all"], workspacePath);
  executeGit(["commit", "-m", "Local benchmark baseline"], workspacePath);
  return executeGit(["rev-parse", "HEAD"], workspacePath).trim();
}

function createLocalEnvironmentFingerprint(workspacePath: string): string {
  const nodeVersion = process.version.replace(/^v/, "");
  const npmVersion = process.platform === "win32"
    ? execFileSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npm --version"], { encoding: "utf8" }).trim()
    : execFileSync("npm", ["--version"], { encoding: "utf8" }).trim();
  return `${process.platform}-node-${nodeVersion}-npm-${npmVersion}-content-${digestDirectory(workspacePath).slice(0, 24)}`;
}

function executeGit(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function digestDirectory(root: string): string {
  const hash = createHash("sha256");
  visit(root, root, hash);
  return hash.digest("hex");
}

function visit(root: string, current: string, hash: ReturnType<typeof createHash>): void {
  for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    if (ignoredArtifactEntries.has(entry.name)) {
      continue;
    }
    const absolutePath = join(current, entry.name);
    const relativePath = absolutePath.slice(root.length).replace(/\\/g, "/");
    hash.update(relativePath);
    if (entry.isDirectory()) {
      visit(root, absolutePath, hash);
    } else {
      hash.update(readFileSync(absolutePath));
    }
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
