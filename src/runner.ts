import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import {
  CopilotClient,
  RuntimeConnection,
  approveAll,
  ToolSet,
  type CopilotSession,
  type ProviderConfig,
} from "@github/copilot-sdk";
import { immutableContractHash } from "./contract.js";
import { EventCollector } from "./event-collector.js";
import { deriveFoundryInferenceBase } from "./foundry-endpoint.js";
import { asRecord } from "./json.js";
import { deriveMetrics, extractModelCalls, extractToolCalls } from "./metrics.js";
import { classifyOutcome } from "./outcome.js";
import { writeRunReport } from "./report.js";
import type {
  BenchmarkConfig,
  BenchmarkRun,
  FoundryProviderConfig,
  FoundryProviderIdentity,
  JsonRecord,
  NormalizedEvent,
  RunContract,
  RunDiagnostics,
  ToolCapability,
} from "./types.js";
import { resolveValidationCommand, runValidation, scrubFoundryEnvironment } from "./validation.js";

export interface BenchmarkRunOptions {
  onEvent?: (event: NormalizedEvent) => void;
}

export async function runBenchmark(config: BenchmarkConfig, options: BenchmarkRunOptions = {}): Promise<BenchmarkRun> {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const artifactsDirectory = resolve(config.artifactsDirectory ?? join(config.workspacePath, ".benchmark-artifacts"), runId);
  mkdirSync(artifactsDirectory, { recursive: true });
  const artifacts = {
    directory: artifactsDirectory,
    rawEvents: join(artifactsDirectory, "raw-events.ndjson"),
    normalizedEvents: join(artifactsDirectory, "normalized-events.ndjson"),
    diagnostics: join(artifactsDirectory, "diagnostics.json"),
    report: join(artifactsDirectory, "report.md"),
  };
  const contract = materializeContract(config);
  assertSupportedPolicy(contract);
  const collector = new EventCollector(artifacts.rawEvents, artifacts.normalizedEvents, options.onEvent);
  collector.captureRunnerEvent("runner.run_started", { runId });

  let sessionId: string | null = null;
  let validation = null;
  let runnerError: string | null = null;
  const sdkToolAllowlist = resolveSdkToolAllowlist(contract.execution.tools);
  const cliPath = resolveCopilotCliPath(process.env);
  const runtimeDirectory = createIsolatedCopilotRuntimeDirectory();
  const client = new CopilotClient({
    workingDirectory: config.workspacePath,
    baseDirectory: runtimeDirectory,
    useLoggedInUser: false,
    env: scrubFoundryEnvironment(process.env),
    // The collector and terminal progress reporter are the supported observability
    // channels. Suppress SDK stderr so provider details cannot bypass redaction.
    logLevel: "none",
    // Force a child runtime: the SDK's in-process transport ignores env/base
    // directory isolation and would expose host credentials to shell tools.
    connection: RuntimeConnection.forStdio(cliPath ? { path: cliPath } : undefined),
  });
  let session: CopilotSession | null = null;
  let compatibilityProxy: TemperatureStrippingProxy | null = null;

  try {
    const provider = resolveFoundryProvider(config.contract.foundryProvider, process.env);
    compatibilityProxy = contract.foundryProvider?.requestAdaptation === "strip-temperature"
      ? await startTemperatureStrippingProxy(provider.baseUrl)
      : await startOpenAiNullRefusalSanitizingProxy(provider.baseUrl);
    const sessionProvider = compatibilityProxy ? { ...provider, baseUrl: compatibilityProxy.baseUrl } : provider;
    await client.start();
    session = await client.createSession({
      model: contract.candidate.model,
      workingDirectory: config.workspacePath,
      streaming: true,
      enableSessionStore: false,
      reasoningEffort: contract.execution.reasoningEffort,
      systemMessage: { content: contract.execution.instructions },
      availableTools: sdkToolAllowlist,
      onPermissionRequest: contract.execution.permissionMode === "approve-all" ? approveAll : undefined,
      provider: sessionProvider,
    });
    sessionId = session.sessionId;
    collector.captureRunnerEvent("runner.session_created", { sessionId });
    for (const event of await session.getEvents()) {
      collector.captureSdkEvent(event);
    }
    const reportedCliVersion = collector.events()
      .find((event) => event.eventType === "session.start")?.data.copilotVersion;
    if (typeof reportedCliVersion === "string") {
      contract.runtime.cliVersion = reportedCliVersion;
    }
    collector.captureRunnerEvent("runner.contract_resolved", {
      contractHash: immutableContractHash(contract),
      cliVersion: contract.runtime.cliVersion,
    });
    const unsubscribe = session.on((event) => collector.captureSdkEvent(event));
    try {
      for (const [index, round] of config.rounds.entries()) {
        collector.captureRunnerEvent("runner.round_started", { round: index + 1 });
        await sendRoundWithRetries(
          session,
          round.prompt,
          round.mode ?? "enqueue",
          contract.execution.sessionTimeoutMs,
          contract.execution.retries,
          index + 1,
          collector,
        );
        collector.captureRunnerEvent("runner.round_finished", { round: index + 1 });
      }
    } finally {
      unsubscribe();
    }
    const usage = await readUsageMetrics(session);
    collector.captureRunnerEvent("runner.usage_metrics", {
      available: usage !== null,
      metrics: usage ?? {},
    });
  } catch (error) {
    runnerError = redactProviderError(error instanceof Error ? error.message : String(error));
    collector.captureRunnerEvent("runner.error", { message: runnerError });
  } finally {
    try {
      if (session) {
        await client.deleteSession(session.sessionId);
      }
    } finally {
      try {
        await client.stop();
      } finally {
        try {
          await compatibilityProxy?.stop();
        } finally {
          rmSync(runtimeDirectory, { recursive: true, force: true });
        }
      }
    }
  }

  validation = await runValidation(
    resolveValidationCommand(contract.task.validationCommand, config.workspacePath),
    config.workspacePath,
    contract.execution.sessionTimeoutMs,
  );
  collector.captureRunnerEvent("runner.validation_finished", asRecord(validation));
  collector.captureRunnerEvent("runner.run_finished", { runId });

  const events = collector.events();
  const modelCalls = extractModelCalls(events);
  const toolCalls = extractToolCalls(events);
  const diagnostics = createRunDiagnostics(events, contract.runtime, sdkToolAllowlist, runnerError);
  const run: BenchmarkRun = {
    runId,
    contract,
    contractHash: immutableContractHash(contract),
    sessionId,
    startedAt,
    completedAt: new Date().toISOString(),
    artifacts,
    diagnostics,
    modelCalls,
    toolCalls,
    usageMetrics: findUsageMetrics(events),
    validation,
    metrics: deriveMetrics(events, modelCalls),
    outcome: classifyOutcome({ validation, toolCalls, runnerError }),
    runnerError,
  };
  writeFileSync(artifacts.diagnostics, `${JSON.stringify(diagnostics, null, 2)}\n`, "utf8");
  writeFileSync(join(artifactsDirectory, "run.json"), `${JSON.stringify(run, null, 2)}\n`, "utf8");
  writeRunReport(run);
  return run;
}

export function loadBenchmarkConfig(path: string): BenchmarkConfig {
  const config: unknown = JSON.parse(readFileSync(path, "utf8"));
  assertFoundryOnlyConfig(config);
  return config;
}

function assertFoundryOnlyConfig(config: unknown): asserts config is BenchmarkConfig {
  if (!isRecord(config) || !isRecord(config.contract)) {
    throw new TypeError("Benchmark configuration must include a contract object.");
  }
  if ("customProvider" in config.contract || "provider" in config.contract) {
    throw new TypeError(
      "Legacy/custom provider configuration is unsupported. Use contract.foundryProvider.type with openai or anthropic.",
    );
  }
  const provider = config.contract.foundryProvider;
  if (!isRecord(provider) || (provider.type !== "openai" && provider.type !== "anthropic")) {
    throw new TypeError(
      "Benchmark configuration requires contract.foundryProvider.type set to exactly openai or anthropic.",
    );
  }
}

const sdkToolsByCapability: Record<ToolCapability, readonly string[]> = {
  read: ["view", "glob"],
  edit: ["edit"],
  shell: process.platform === "win32" ? ["powershell"] : ["bash"],
};

/**
 * Keeps the benchmark contract provider-neutral while translating its
 * capabilities to source-qualified Copilot SDK tool filters.
 */
export function resolveSdkToolAllowlist(capabilities: readonly ToolCapability[]): string[] {
  const builtInTools = [...new Set(capabilities.flatMap((capability) => sdkToolsByCapability[capability]))];
  return new ToolSet().addBuiltIn(builtInTools).toArray();
}

/**
 * Keep COPILOT_HOME short on Windows: the CLI adds session-state paths beneath
 * it, and SQLite cannot reliably open paths nested under long artifact roots.
 */
export function createIsolatedCopilotRuntimeDirectory(): string {
  return mkdtempSync(join(tmpdir(), "benchmark-copilot-runtime-"));
}

/**
 * Prefer an explicitly selected or installed CLI over the SDK's embedded
 * runtime. This lets the workshop capture fixes released between SDK package
 * updates while retaining the bundled runtime as a no-install fallback.
 */
export function resolveCopilotCliPath(
  environment: NodeJS.ProcessEnv,
  platform = process.platform,
  resolveExecutable: (command: string) => string | null = findExecutable,
): string | undefined {
  const configuredPath = environment.BENCHMARK_COPILOT_CLI_PATH?.trim();
  if (configuredPath) {
    return configuredPath;
  }
  return resolveExecutable(platform === "win32" ? "copilot.exe" : "copilot") ?? undefined;
}

function findExecutable(command: string): string | null {
  try {
    const lookup = process.platform === "win32" ? "where.exe" : "which";
    const output = execFileSync(lookup, [command], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return output.split(/\r?\n/).find((path) => path.trim())?.trim() ?? null;
  } catch {
    return null;
  }
}

export function createRunDiagnostics(
  events: readonly NormalizedEvent[],
  runtime: RunContract["runtime"],
  configuredToolFilters: readonly string[],
  runnerError: string | null,
): RunDiagnostics {
  const sessionStart = events.find((event) => event.eventType === "session.start");
  const configurationMessages = events
    .filter((event) => event.eventType === "session.info" && event.data.infoType === "configuration")
    .flatMap((event) => typeof event.data.message === "string" ? [event.data.message] : []);
  const httpStatus = runnerError?.match(/\b([45]\d{2})\b/)?.[1];
  return {
    schemaVersion: 1,
    runtime,
    selectedModel: typeof sessionStart?.data.selectedModel === "string" ? sessionStart.data.selectedModel : null,
    configuredToolFilters: [...configuredToolFilters],
    configurationMessages,
    providerFailure: {
      httpStatus: httpStatus ? Number(httpStatus) : null,
      signature: /temperature.*deprecated/i.test(runnerError ?? "")
        ? "anthropic_temperature_deprecated"
      : /resource not found on provider.*\b404\b/i.test(runnerError ?? "")
        ? "provider_resource_not_found"
        : runnerError ? "other" : null,
      message: runnerError,
    },
  };
}

function redactProviderError(message: string): string {
  return message.replace(/https?:\/\/[^\s)"']+/gi, "<redacted-provider-url>");
}

export interface TemperatureStrippingProxy {
  baseUrl: string;
  stop(): Promise<void>;
}

/**
 * The current Copilot CLI Anthropic adapter emits temperature for some model
 * IDs that Foundry rejects. Keep the workaround isolated to localhost and
 * remove only that field before forwarding the otherwise untouched request.
 */
export async function startTemperatureStrippingProxy(targetBaseUrl: string): Promise<TemperatureStrippingProxy> {
  return startRequestSanitizingProxy(targetBaseUrl, stripTemperature);
}

/**
 * Foundry OpenAI-compatible deployments such as FW-Kimi-K3 reject the
 * Copilot SDK's null continuation refusal field. Strip only that null field
 * from message arrays; populated refusal values and all other fields remain.
 */
export async function startOpenAiNullRefusalSanitizingProxy(targetBaseUrl: string): Promise<TemperatureStrippingProxy> {
  return startRequestSanitizingProxy(targetBaseUrl, stripNullMessageRefusals);
}

async function startRequestSanitizingProxy(
  targetBaseUrl: string,
  transform: (body: Buffer, contentType: string | string[] | undefined) => Buffer,
): Promise<TemperatureStrippingProxy> {
  const targetBase = new URL(targetBaseUrl);
  const server = createServer((incoming, outgoing) => {
    void forwardSanitizedRequest(incoming, outgoing, targetBase, transform);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Unable to determine the local compatibility proxy port.");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    stop: () => closeServer(server),
  };
}

async function forwardSanitizedRequest(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  targetBase: URL,
  transform: (body: Buffer, contentType: string | string[] | undefined) => Buffer,
): Promise<void> {
  try {
    const requestBody = await readRequestBody(incoming);
    const body = transform(requestBody, incoming.headers["content-type"]);
    const target = new URL(`${targetBase.pathname.replace(/\/$/, "")}${incoming.url ?? "/"}`, targetBase.origin);
    const headers = forwardedHeaders(incoming.headers, body.length);
    const forward = target.protocol === "https:" ? httpsRequest : httpRequest;
    const upstream = forward(target, { method: incoming.method, headers }, (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    });
    upstream.once("error", () => {
      if (!outgoing.headersSent) {
        outgoing.writeHead(502, { "content-type": "application/json" });
      }
      outgoing.end(JSON.stringify({ error: "Local provider compatibility proxy could not reach the upstream endpoint." }));
    });
    upstream.end(body);
  } catch {
    if (!outgoing.headersSent) {
      outgoing.writeHead(400, { "content-type": "application/json" });
    }
    outgoing.end(JSON.stringify({ error: "Local provider compatibility proxy could not process the request." }));
  }
}

function readRequestBody(incoming: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    incoming.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 10 * 1024 * 1024) {
        reject(new RangeError("Provider request exceeds the 10 MB compatibility proxy limit."));
        incoming.destroy();
        return;
      }
      chunks.push(chunk);
    });
    incoming.once("end", () => resolve(Buffer.concat(chunks)));
    incoming.once("error", reject);
  });
}

function stripTemperature(body: Buffer, contentType: string | string[] | undefined): Buffer {
  if (!contentType?.toString().toLowerCase().includes("application/json") || body.length === 0) {
    return body;
  }
  const payload = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
  delete payload.temperature;
  return Buffer.from(JSON.stringify(payload), "utf8");
}

export function stripNullMessageRefusals(body: Buffer, contentType: string | string[] | undefined): Buffer {
  if (!contentType?.toString().toLowerCase().includes("application/json") || body.length === 0) {
    return body;
  }
  return Buffer.from(JSON.stringify(sanitizeMessageArrays(JSON.parse(body.toString("utf8")))), "utf8");
}

function sanitizeMessageArrays(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeMessageArrays);
  }
  if (!isRecord(value)) {
    return value;
  }
  const sanitized: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === "messages" && Array.isArray(nested)) {
      sanitized[key] = nested.map(sanitizeMessage);
    } else {
      sanitized[key] = sanitizeMessageArrays(nested);
    }
  }
  return sanitized;
}

function sanitizeMessage(value: unknown): unknown {
  if (!isRecord(value)) {
    return sanitizeMessageArrays(value);
  }
  const sanitized = sanitizeMessageArrays(value) as Record<string, unknown>;
  if (sanitized.refusal === null) {
    delete sanitized.refusal;
  }
  return sanitized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function forwardedHeaders(headers: IncomingHttpHeaders, contentLength: number): IncomingHttpHeaders {
  const forwarded = { ...headers };
  delete forwarded.host;
  delete forwarded["transfer-encoding"];
  forwarded["content-length"] = String(contentLength);
  return forwarded;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function materializeContract(config: BenchmarkConfig): RunContract {
  return {
    contractVersion: 1,
    task: config.contract.task,
    candidate: config.contract.candidate,
    execution: config.contract.execution,
    runtime: {
      sdkVersion: config.contract.runtime?.sdkVersion ?? installedSdkVersion(),
      cliVersion: config.contract.runtime?.cliVersion ?? "runtime-reported-in-session.start-event",
      nodeVersion: config.contract.runtime?.nodeVersion ?? process.version,
    },
    foundryProvider: createFoundryProviderIdentity(config.contract.foundryProvider, process.env),
  };
}

function assertSupportedPolicy(contract: RunContract): void {
  if (contract.execution.concurrency !== 1) {
    throw new RangeError("This MVP executes one persistent session at a time; set execution.concurrency to 1.");
  }
  if (contract.execution.cachePolicy !== "default") {
    throw new RangeError("The installed SDK exposes cache metrics but this MVP does not control cache policy; use execution.cachePolicy 'default'.");
  }
}

export function resolveFoundryProvider(
  config: FoundryProviderConfig,
  environment: NodeJS.ProcessEnv,
): ProviderConfig {
  const baseUrl = deriveFoundryInferenceBase(requiredEnvironmentValue("FOUNDRY_ENDPOINT", environment), config.type);
  const apiKey = requiredEnvironmentValue("FOUNDRY_API_KEY", environment);
  return {
    type: config.type,
    baseUrl,
    apiKey,
    bearerToken: undefined,
    wireApi: config.type === "openai" ? "completions" : undefined,
    azure: undefined,
  };
}

export function createFoundryProviderIdentity(
  config: FoundryProviderConfig,
  environment: NodeJS.ProcessEnv,
): FoundryProviderIdentity {
  const baseUrl = deriveFoundryInferenceBase(requiredEnvironmentValue("FOUNDRY_ENDPOINT", environment), config.type);
  return {
    type: config.type,
    endpointFingerprint: createHash("sha256").update(baseUrl).digest("hex"),
    requestAdaptation: config.type === "openai" ? "openai-null-refusal-sanitizer" : "strip-temperature",
  };
}

function requiredEnvironmentValue(name: string, environment: NodeJS.ProcessEnv): string {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
    throw new TypeError(`Environment variable name "${name}" is invalid.`);
  }
  const value = environment[name]?.trim();
  if (!value) {
    if (name === "FOUNDRY_API_KEY") {
      throw new Error(
        'FOUNDRY_API_KEY is required but is not set. Set it in the current PowerShell session only: $env:FOUNDRY_API_KEY = "<your-foundry-api-key>"',
      );
    }
    throw new Error(`Required Foundry environment variable "${name}" is not set.`);
  }
  return value;
}

async function sendRoundWithRetries(
  session: CopilotSession,
  prompt: string,
  mode: "enqueue" | "immediate",
  timeoutMs: number,
  retries: number,
  round: number,
  collector: EventCollector,
): Promise<void> {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      await session.sendAndWait({ prompt, mode }, timeoutMs);
      return;
    } catch (error) {
      if (attempt === retries) {
        throw error;
      }
      collector.captureRunnerEvent("runner.round_retry", {
        round,
        attempt: attempt + 1,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function installedSdkVersion(): string {
  const packageJson = JSON.parse(readFileSync(join(process.cwd(), "node_modules", "@github", "copilot-sdk", "package.json"), "utf8")) as {
    version?: unknown;
  };
  return typeof packageJson.version === "string" ? packageJson.version : "unknown";
}

async function readUsageMetrics(session: CopilotSession): Promise<JsonRecord | null> {
  const adapter = session as unknown as {
    usage?: { getMetrics?: () => Promise<unknown> };
    rpc?: { usage?: { getMetrics?: () => Promise<unknown> } };
  };
  if (adapter.usage?.getMetrics) {
    return asRecord(await adapter.usage.getMetrics());
  }
  if (adapter.rpc?.usage?.getMetrics) {
    return asRecord(await adapter.rpc.usage.getMetrics());
  }
  return null;
}

function findUsageMetrics(events: readonly { eventType: string; data: JsonRecord }[]): JsonRecord | null {
  const data = events.find((event) => event.eventType === "runner.usage_metrics")?.data;
  return data?.available === true && typeof data.metrics === "object" && data.metrics !== null && !Array.isArray(data.metrics)
    ? asRecord(data.metrics)
    : null;
}
