import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
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
  type MCPServerConfig,
  type ProviderConfig,
} from "@github/copilot-sdk";
import { immutableContractHash } from "./contract.js";
import { EventCollector } from "./event-collector.js";
import { deriveFoundryInferenceBase } from "./foundry-endpoint.js";
import { asRecord } from "./json.js";
import { deriveMetrics, extractModelCalls, extractToolCalls } from "./metrics.js";
import { classifyOutcome } from "./outcome.js";
import { writeRunReport } from "./report.js";
import { captureWorkspaceChanges } from "./workspace-changes.js";
import type {
  BenchmarkConfig,
  BenchmarkRun,
  FoundryProviderConfig,
  FoundryProviderIdentity,
  JsonRecord,
  McpServerSpec,
  NormalizedEvent,
  RunContract,
  RunDiagnostics,
  ToolCapability,
} from "./types.js";
import { resolveValidationCommand, runValidation, scrubFoundryEnvironment } from "./validation.js";
import { inspectArtifact } from "./artifact-inspection.js";
import { runConformanceProbe } from "./conformance.js";
import { providerAuthentication, providerSchema } from "./auth.js";
import { atomicJson } from "./durable.js";
import { DispatchError, RequestGuard, DeploymentAdmission, retryDelay, canRetryRequest } from "./request-policy.js";
import { ControlledWorker, collectSnapshot, snapshotHash } from "./controlled-worker.js";
import type { EventCollector as Collector } from "./event-collector.js";
import { readRuntimeIdentity } from "./runtime-identity.js";
import { evidenceHash } from "./evidence.js";

export interface BenchmarkRunOptions {
  onEvent?: (event: NormalizedEvent) => void;
  runId?: string;
  admission?: DeploymentAdmission;
  onPhase?: (phase: string, evidence: { runId: string; artifactsDirectory: string }) => void;
  deadlineAt?: number;
}

async function rejectedReason(response: IncomingMessage): Promise<string> {
  let text = "";
  for await (const chunk of response) {
    text += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (text.length > 65536) { response.destroy(); break; }
  }
  if (/AuthenticationTypeDisabled|key.?based authentication is disabled/i.test(text)) return "azure-key-auth-disabled";
  if (/insufficient_quota|billing_hard_limit|quota[_ -]?(?:exceeded|exhausted)/i.test(text)) return "permanent-quota";
  return "provider-policy-or-request";
}
export interface BenchmarkWorkRequest {
  kind: "task" | "round";
  prompt: string;
  mode: "enqueue" | "immediate";
  round: number | null;
}

/**
 * The immutable task is always the first user work request. Rounds are
 * follow-up turns, not an alternate place to repeat the task specification.
 */
export function benchmarkWorkRequests(
  taskPrompt: string,
  rounds: readonly { prompt: string; mode?: "enqueue" | "immediate" }[],
): BenchmarkWorkRequest[] {
  return [
    { kind: "task", prompt: taskPrompt, mode: "immediate", round: null },
    ...rounds.map((round, index) => ({
      kind: "round" as const,
      prompt: round.prompt,
      mode: round.mode ?? "enqueue",
      round: index + 1,
    })),
  ];
}

export async function runBenchmark(config: BenchmarkConfig, options: BenchmarkRunOptions = {}): Promise<BenchmarkRun> {
  const contract = materializeContract(config);
  const runId = options.runId ?? randomUUID();
  const startedAt = new Date().toISOString();
  const artifactsDirectory = resolve(config.artifactsDirectory ?? join(config.workspacePath, ".benchmark-artifacts"), runId);
  mkdirSync(artifactsDirectory, { recursive: true });
  const artifacts = {
    directory: artifactsDirectory,
    rawEvents: join(artifactsDirectory, "raw-events.ndjson"),
    normalizedEvents: join(artifactsDirectory, "normalized-events.ndjson"),
    diagnostics: join(artifactsDirectory, "diagnostics.json"),
    report: join(artifactsDirectory, "report.md"),
    changes: join(artifactsDirectory, "changes.patch"),
    workspace: resolve(config.workspacePath),
    inspection: join(artifactsDirectory, "artifact-inspection.json"),
    conformance: join(artifactsDirectory, "conformance-probe.json"),
  };
  assertSupportedPolicy(contract);
  const collector = new EventCollector(artifacts.rawEvents, artifacts.normalizedEvents, options.onEvent);
  collector.captureRunnerEvent("runner.run_started", { runId });
  const phase = (value: string) => {
    atomicJson(join(artifactsDirectory, "phase.json"), { schemaVersion: 1, runId, phase: value, updatedAt: new Date().toISOString() });
    options.onPhase?.(value, { runId, artifactsDirectory });
  };
  phase("prepared");

  let sessionId: string | null = null;
  let runnerError: string | null = null;
  let executionComplete = false;
  const sdkToolAllowlist = resolveSdkToolAllowlist(contract.execution.tools, contract.execution.mcpServers);
  const mcpServers = resolveMcpServersForLaunch(contract.execution.mcpServers, process.env);
  const cliPath = resolveCopilotCliPath(process.env);
  const runtimeDirectory = createIsolatedCopilotRuntimeDirectory();
  const client = new CopilotClient({
    workingDirectory: config.isolation ? runtimeDirectory : config.workspacePath,
    baseDirectory: runtimeDirectory,
    useLoggedInUser: false,
    env: scrubFoundryEnvironment(process.env),
    // The collector and terminal progress reporter are the supported observability
    // channels. Suppress SDK stderr so provider details cannot bypass redaction.
    logLevel: "none",
    // Force a child runtime: the SDK's in-process transport ignores env/base
    // directory isolation and would expose host credentials to shell tools.
    connection: RuntimeConnection.forStdio(cliPath ? { path: cliPath } : undefined),
    ...(config.isolation ? { mode: "empty" as const } : {}),
  });
  let session: CopilotSession | null = null;
  let compatibilityProxy: TemperatureStrippingProxy | null = null;
  const guardStarted = Date.now();
  const stages = 3 + config.rounds.length + (contract.task.conformanceProbe?.checks.length ?? 0)
    + (contract.task.conformanceProbe?.setupCommand ? 1 : 0);
  const guard = new RequestGuard(config.requestBounds, guardStarted,
    options.deadlineAt ?? guardStarted + contract.execution.sessionTimeoutMs * stages);
  let worker: ControlledWorker | null = null;

  try {
    if (config.isolation) {
      if (mcpServers) throw new TypeError("Isolated mode does not allow host/remote MCP servers.");
      worker = await ControlledWorker.create(config.isolation,
        collectSnapshot(config.workspacePath, config.isolation.maxFiles, config.isolation.maxBytes),
        join(artifactsDirectory, "controlled-worker.json"), undefined, undefined, guard.deadline);
    }
    const provider = resolveFoundryProvider(config.contract.foundryProvider, process.env);
    compatibilityProxy = await startRequestSanitizingProxy(provider.baseUrl,
      contract.foundryProvider?.requestAdaptation === "strip-temperature" ? stripTemperature : stripNullMessageRefusals,
      { guard, retries: contract.execution.retries, admission: options.admission,
        deployment: `${contract.foundryProvider?.endpointFingerprint}/${contract.candidate.model}`,
        wireApi: provider.wireApi, capture: (type, data) => collector.captureRunnerEvent(type, data) });
    const sessionProvider = compatibilityProxy ? { ...provider, baseUrl: compatibilityProxy.baseUrl } : provider;
    await client.start();
    session = await client.createSession({
      model: contract.candidate.model,
      workingDirectory: config.isolation ? runtimeDirectory : config.workspacePath,
      streaming: true,
      enableSessionStore: false,
      reasoningEffort: contract.execution.reasoningEffort,
      systemMessage: { content: contract.execution.instructions },
      availableTools: worker ? new ToolSet().addCustom("controlled_workspace").toArray() : sdkToolAllowlist,
      ...(worker ? { tools: [worker.tool(contract.execution.tools)] } : {}),
      onPermissionRequest: contract.execution.permissionMode === "approve-all" ? approveAll : undefined,
      provider: sessionProvider,
      ...(mcpServers ? { mcpServers } : {}),
    });
    const activeSession = session;
    phase("running");
    sessionId = activeSession.sessionId;
    collector.captureRunnerEvent("runner.session_created", { sessionId });
    for (const event of await activeSession.getEvents()) {
      collector.captureSdkEvent(event);
    }
    collector.captureRunnerEvent("runner.contract_resolved", {
      contractHash: immutableContractHash(contract),
      cliVersion: contract.runtime.cliVersion,
    });
    const unsubscribe = session.on((event) => collector.captureSdkEvent(event));
    try {
      await dispatchBenchmarkWorkRequests(
        benchmarkWorkRequests(contract.task.prompt, config.rounds),
        async (request) => {
          await activeSession.sendAndWait(
            { prompt: request.prompt, mode: request.mode },
            Math.max(1, Math.min(contract.execution.sessionTimeoutMs, guard.deadline - Date.now())),
          );
        },
        0,
        (eventType, data) => collector.captureRunnerEvent(eventType, data),
      );
      if (guard.accounting.ambiguousRequests) throw new DispatchError("Provider returned ambiguous completion evidence; the work plan is interrupted.", "possibly-processed");
      executionComplete = true;
      phase("execution-complete");
    } finally {
      unsubscribe();
    }
    const usage = await readUsageMetrics(activeSession);
    collector.captureRunnerEvent("runner.usage_metrics", {
      available: usage !== null,
      metrics: usage ?? {},
    });
  } catch (error) {
    executionComplete = false;
    runnerError = redactProviderError(error instanceof Error ? error.message : String(error));
    collector.captureRunnerEvent("runner.error", { message: runnerError });
  } finally {
    phase("draining");
    atomicJson(join(artifactsDirectory, "execution.json"), {
      schemaVersion: 1, runId, contract, contractHash: immutableContractHash(contract), startedAt, sessionId, runnerError,
      executionComplete: false,
      requestAccounting: guard.accounting,
    });
    try {
      try {
        if (session) await client.deleteSession(session.sessionId);
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
    } catch (error) {
      try { await worker?.stop(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], "Runtime shutdown and owned worker stop failed; retain the recovery records."); }
      throw error;
    }
  }

  executionComplete = executionComplete && guard.cleanlySettled();
  atomicJson(join(artifactsDirectory, "execution.json"), {
    schemaVersion: 1, runId, contract, contractHash: immutableContractHash(contract), startedAt, sessionId, runnerError, executionComplete,
    requestAccounting: guard.accounting,
  });
  return finalizeExecution(config, { runId, contract, contractHash: immutableContractHash(contract), startedAt, sessionId, runnerError, executionComplete, requestAccounting: guard.accounting }, collector, phase, worker, guard.deadline);
}

interface ExecutionCheckpoint {
  runId: string; contract: RunContract; startedAt: string; sessionId: string | null; runnerError: string | null;
  contractHash: string; executionComplete: boolean;
  requestAccounting: NonNullable<BenchmarkRun["requestAccounting"]>;
}

export async function resumeBenchmarkFinalization(config: BenchmarkConfig, runId: string, options: BenchmarkRunOptions = {}): Promise<BenchmarkRun> {
  const directory = resolve(config.artifactsDirectory ?? join(config.workspacePath, ".benchmark-artifacts"), runId);
  const saved = JSON.parse(readFileSync(join(directory, "execution.json"), "utf8")) as ExecutionCheckpoint;
  if (saved.runId !== runId || !saved.contract || !saved.requestAccounting || typeof saved.executionComplete !== "boolean"
      || immutableContractHash(saved.contract) !== saved.contractHash
      || evidenceHash(saved.contract.task) !== evidenceHash(config.contract.task)
      || evidenceHash(saved.contract.execution) !== evidenceHash(config.contract.execution)
      || evidenceHash(saved.contract.rounds) !== evidenceHash(config.rounds)
      || evidenceHash(saved.contract.candidate) !== evidenceHash(config.contract.candidate)
      || evidenceHash(saved.contract.executionProfile) !== evidenceHash(executionProfile(config))
      || saved.contract.foundryProvider?.type !== config.contract.foundryProvider.type
      || (saved.contract.foundryProvider.wireApi ?? "completions") !== (config.contract.foundryProvider.wireApi ?? "completions")
      || Object.entries(config.contract.runtime ?? {}).some(([key, value]) => value !== saved.contract.runtime[key as keyof typeof saved.contract.runtime])) {
    throw new TypeError("Invalid or mismatched saved execution checkpoint.");
  }
  const collector = new EventCollector(join(directory, "raw-events.ndjson"), join(directory, "normalized-events.ndjson"), options.onEvent);
  const phase = (value: string) => {
    atomicJson(join(directory, "phase.json"), { schemaVersion: 1, runId, phase: value, updatedAt: new Date().toISOString() });
    options.onPhase?.(value, { runId, artifactsDirectory: directory });
  };
  return finalizeExecution(config, saved, collector, phase, null, options.deadlineAt);
}

async function finalizeExecution(
  config: BenchmarkConfig, saved: ExecutionCheckpoint, collector: Collector, phase: (value: string) => void, worker: ControlledWorker | null,
  deadlineAt = Date.now() + config.contract.execution.sessionTimeoutMs,
): Promise<BenchmarkRun> {
  const { runId, contract, startedAt, sessionId, runnerError } = saved;
  const artifactsDirectory = resolve(config.artifactsDirectory ?? join(config.workspacePath, ".benchmark-artifacts"), runId);
  let workspace = config.workspacePath, workspaceHash: string | undefined;
  if (config.isolation) {
    workspace = join(artifactsDirectory, "workspace");
    if (!existsSync(workspace)) {
      worker ??= await ControlledWorker.reopen(join(artifactsDirectory, "controlled-worker.json"), undefined, deadlineAt);
      workspaceHash = await worker.snapshot(workspace);
      await worker.dispose();
    } else {
      workspaceHash = snapshotHash(collectSnapshot(workspace, config.isolation.maxFiles, config.isolation.maxBytes));
      const snapshot = JSON.parse(readFileSync(join(artifactsDirectory, "controlled-worker.json.snapshot.json"), "utf8")) as { workspaceHash: string };
      if (snapshot.workspaceHash !== workspaceHash) throw new Error("Retained exported workspace hash changed.");
      await ControlledWorker.cleanup(join(artifactsDirectory, "controlled-worker.json"));
    }
  }
  const artifacts = {
    directory: artifactsDirectory, rawEvents: join(artifactsDirectory, "raw-events.ndjson"),
    normalizedEvents: join(artifactsDirectory, "normalized-events.ndjson"), diagnostics: join(artifactsDirectory, "diagnostics.json"),
    report: join(artifactsDirectory, "report.md"), changes: join(artifactsDirectory, "changes.patch"), workspace,
    inspection: join(artifactsDirectory, "artifact-inspection.json"), conformance: join(artifactsDirectory, "conformance-probe.json"),
  };
  const workspaceChanges = captureWorkspaceChanges(workspace, contract.task.repository.commitSha);
  phase("exported");
  if (workspaceChanges.patch !== null) {
    writeFileSync(artifacts.changes, workspaceChanges.patch, "utf8");
  }
  collector.captureRunnerEvent("runner.workspace_changes_captured", {
    available: workspaceChanges.patch !== null,
    filesChanged: workspaceChanges.filesChanged,
    insertions: workspaceChanges.insertions,
    deletions: workspaceChanges.deletions,
    reason: workspaceChanges.reason ?? null,
  });

  let gradingWorker: ControlledWorker | null = null;
  if (config.isolation) gradingWorker = await ControlledWorker.create(config.isolation,
    collectSnapshot(workspace, config.isolation.maxFiles, config.isolation.maxBytes), join(artifactsDirectory, `grader-worker-${randomUUID()}.json`), undefined, undefined, deadlineAt);
  const validate: typeof runValidation = gradingWorker
    ? (command, _cwd, timeout) => gradingWorker!.validate(command, timeout)
    : runValidation;
  const execute: typeof runValidation = (command, cwd, timeout) => {
    if (Date.now() >= deadlineAt) throw new Error("Finalization absolute deadline exceeded; retained execution can be finalized without inference.");
    return validate(command, cwd, Math.max(1, Math.min(timeout, deadlineAt - Date.now())));
  };
  let validation: BenchmarkRun["validation"] = null;
  let conformance = null;
  try {
  validation = await execute(
    resolveValidationCommand(contract.task.validationCommand, workspace),
    workspace,
    contract.execution.sessionTimeoutMs,
  );
  phase("validation-complete");
  collector.captureRunnerEvent("runner.validation_finished", asRecord(validation));

  // Captured after validation so the inspected artifact is the exact tree the
  // deterministic command was run against.
  const inspection = inspectArtifact(workspace);
  writeFileSync(artifacts.inspection, `${JSON.stringify(inspection, null, 2)}\n`, "utf8");
  collector.captureRunnerEvent("runner.artifact_inspected", {
    available: inspection.available,
    reason: inspection.reason ?? null,
    sourceFiles: inspection.totals.sourceFiles,
    testFiles: inspection.totals.testFiles,
    sourceLines: inspection.totals.sourceLines,
    unresolvedEntryPoints: inspection.entryPoints.filter((entry) => !entry.exists).length,
    driftedDependencies: inspection.dependencyDrift.filter((entry) => entry.satisfied === false).length,
    testFilesUnderBuildOutput: inspection.testFilesUnderBuildOutput.length,
  });
  // Runs last so the probe sees the same tree validation and inspection saw.
  // A probe is task-owned and the agent never sees it, so passing it is
  // evidence about the delivered code rather than about the delivered tests.
  conformance = contract.task.conformanceProbe
    ? await runConformanceProbe(
        contract.task.conformanceProbe,
        workspace,
        contract.task.conformanceProbe.timeoutMs ?? contract.execution.sessionTimeoutMs,
        execute,
      )
    : null;
  if (conformance !== null) {
    writeFileSync(artifacts.conformance, `${JSON.stringify(conformance, null, 2)}\n`, "utf8");
    collector.captureRunnerEvent("runner.conformance_probe_finished", {
      available: conformance.available,
      reason: conformance.reason ?? null,
      conformant: conformance.conformant,
      ...conformance.totals,
      durationMs: conformance.durationMs,
    });
  }
  } finally { await gradingWorker?.dispose(); }

  collector.captureRunnerEvent("runner.run_finished", { runId });
  const events = collector.events();
  const modelCalls = extractModelCalls(events);
  const toolCalls = extractToolCalls(events);
  const diagnostics = createRunDiagnostics(events, contract.runtime, resolveSdkToolAllowlist(contract.execution.tools), runnerError);
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
    ...(conformance === null ? {} : { conformance }),
    metrics: deriveMetrics(events, modelCalls),
    outcome: classifyOutcome({ validation, toolCalls, runnerError, executionComplete: saved.executionComplete }),
    runnerError,
    executionStatus: saved.executionComplete ? "completed" : "interrupted",
    requestAccounting: saved.requestAccounting,
    ...(workspaceHash ? { workspaceHash } : {}),
  };
  writeFileSync(artifacts.diagnostics, `${JSON.stringify(diagnostics, null, 2)}\n`, "utf8");
  atomicJson(join(artifactsDirectory, "run.json"), run);
  writeRunReport(run);
  phase("finalized");
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
  const candidate = config.contract.candidate;
  if (!isRecord(candidate) || (candidate.provider !== "openai" && candidate.provider !== "anthropic")) {
    throw new TypeError(
      "Benchmark configuration requires contract.candidate.provider set to exactly openai or anthropic.",
    );
  }
  if (candidate.provider !== provider.type) {
    throw new TypeError(
      `Benchmark configuration requires contract.candidate.provider (${candidate.provider}) to match ` +
        `contract.foundryProvider.type (${provider.type}).`,
    );
  }
  providerSchema.parse(provider);
}

const sdkToolsByCapability: Record<ToolCapability, readonly string[]> = {
  read: ["view", "glob"],
  edit: ["edit"],
  shell: process.platform === "win32" ? ["powershell"] : ["bash"],
};

/**
 * Keeps the benchmark contract provider-neutral while translating its
 * capabilities to source-qualified Copilot SDK tool filters. When the contract
 * configures MCP servers, their tools are also exposed (`mcp:*`); the per-server
 * `tools` filter still governs which individual tools each server advertises.
 * With no MCP servers configured the output is identical to the built-in-only
 * allowlist, so existing read/edit/shell runs are unaffected.
 */
export function resolveSdkToolAllowlist(
  capabilities: readonly ToolCapability[],
  mcpServers?: Record<string, McpServerSpec>,
): string[] {
  const builtInTools = [...new Set(capabilities.flatMap((capability) => sdkToolsByCapability[capability]))];
  const toolSet = new ToolSet().addBuiltIn(builtInTools);
  if (mcpServers && Object.keys(mcpServers).length > 0) {
    toolSet.addMcp("*");
  }
  return toolSet.toArray();
}

/**
 * Expands `${ENV_VAR}` placeholders inside MCP server specs from the process
 * environment at launch time and returns the SDK-shaped server map. Because the
 * contract stores the unexpanded placeholders, secrets never land in config
 * files or run artifacts. Returns `undefined` when no servers are configured so
 * the `createSession` call is byte-identical to the default flow.
 */
export function resolveMcpServersForLaunch(
  mcpServers: Record<string, McpServerSpec> | undefined,
  environment: NodeJS.ProcessEnv,
): Record<string, MCPServerConfig> | undefined {
  if (!mcpServers || Object.keys(mcpServers).length === 0) {
    return undefined;
  }
  const resolved: Record<string, MCPServerConfig> = {};
  for (const [name, spec] of Object.entries(mcpServers)) {
    resolved[name] = expandPlaceholders(spec, environment, `mcpServers.${name}`) as MCPServerConfig;
  }
  return resolved;
}

function expandPlaceholders(value: unknown, environment: NodeJS.ProcessEnv, path: string): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_match, name: string) => {
      const resolved = environment[name];
      if (resolved === undefined) {
        throw new Error(
          `MCP configuration ${path} references environment variable ${name}, which is not set. ` +
            "Export it before running, or remove the placeholder.",
        );
      }
      return resolved;
    });
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => expandPlaceholders(item, environment, `${path}[${index}]`));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        expandPlaceholders(item, environment, `${path}.${key}`),
      ]),
    );
  }
  return value;
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
  const configuredPath = environment.BENCHMARK_COPILOT_CLI_PATH?.trim() || environment.COPILOT_CLI_PATH?.trim();
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
  const bridge = events.filter((event) => event.eventType === "runner.provider_bridge_error").at(-1);
  const rejected = events.filter((event) => event.eventType === "runner.provider_rejected" && typeof event.data.status === "number").at(-1);
  const httpStatus = typeof bridge?.data.status === "number" ? String(bridge.data.status)
    : typeof rejected?.data.status === "number" ? String(rejected.data.status) : runnerError?.match(/\b([45]\d{2})\b/)?.[1];
  // The generic session-level auth error the CLI surfaces (and that we store as
  // runnerError) never carries the underlying provider error code, so detect
  // this signature from the raw model.call_failure event instead of runnerError.
  const azureKeyAuthDisabled = events.some((event) => {
    if (event.eventType === "runner.provider_rejected" && event.data.reason === "azure-key-auth-disabled") return true;
    if (event.eventType !== "model.call_failure") {
      return false;
    }
    const errorMessage = event.data.errorMessage;
    return typeof errorMessage === "string"
      && /AuthenticationTypeDisabled|key.?based authentication is disabled/i.test(errorMessage);
  });
  return {
    schemaVersion: 1,
    runtime,
    ...(typeof sessionStart?.data.copilotVersion === "string" ? { reportedBackendVersion: sessionStart.data.copilotVersion } : {}),
    selectedModel: typeof sessionStart?.data.selectedModel === "string" ? sessionStart.data.selectedModel : null,
    configuredToolFilters: [...configuredToolFilters],
    configurationMessages,
    providerFailure: {
      httpStatus: httpStatus ? Number(httpStatus) : null,
      signature: azureKeyAuthDisabled
        ? "azure_key_auth_disabled"
      : rejected?.data.reason === "permanent-quota"
        ? "permanent_quota"
      : /temperature.*deprecated/i.test(runnerError ?? "")
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

export async function startRequestSanitizingProxy(
  targetBaseUrl: string,
  transform: (body: Buffer, contentType: string | string[] | undefined) => Buffer,
  options: ProxyOptions = {},
): Promise<TemperatureStrippingProxy> {
  options = { ...options, guard: options.guard ?? new RequestGuard(), admission: options.admission ?? new DeploymentAdmission() };
  const targetBase = new URL(targetBaseUrl);
  const server = createServer((incoming, outgoing) => {
    void forwardSanitizedRequest(incoming, outgoing, targetBase, transform, options);
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

export interface ProxyOptions {
  guard?: RequestGuard;
  retries?: number;
  admission?: DeploymentAdmission;
  deployment?: string;
  wireApi?: "completions" | "responses";
  capture?: (type: string, data: JsonRecord) => void;
}
async function forwardSanitizedRequest(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  targetBase: URL,
  transform: (body: Buffer, contentType: string | string[] | undefined) => Buffer,
  options: ProxyOptions,
): Promise<void> {
  const guard = options.guard ?? new RequestGuard();
  let dispatched = false;
  try {
    if (incoming.method !== "POST" || !/^\/(?:v1\/)?(?:chat\/completions|responses|messages)(?:\?[^#]*)?$/.test(incoming.url ?? "")) {
      throw new DispatchError("Only inference POST routes are permitted by the provider bridge.", "not-dispatched");
    }
    if (options.wireApi && !(incoming.url ?? "").split("?")[0].endsWith(options.wireApi === "responses" ? "/responses" : "/chat/completions")) {
      throw new DispatchError("Inference route differs from the recorded wire API.", "not-dispatched");
    }
    const requestBody = await readRequestBody(incoming, guard.bounds?.maxRequestBytes);
    let body = transform(requestBody, incoming.headers["content-type"]);
    if (guard.bounds) {
      const payload = JSON.parse(body.toString()) as Record<string, unknown>;
      assertTextTokenReservation(payload);
      const field = options.wireApi === "responses" ? "max_output_tokens" : incoming.url?.includes("messages") ? "max_tokens" : "max_completion_tokens";
      const existing = payload[field];
      payload[field] = typeof existing === "number" ? Math.min(existing, guard.bounds.maxOutputTokens) : guard.bounds.maxOutputTokens;
      body = Buffer.from(JSON.stringify(payload));
    }
    const tokens = body.length + (guard.bounds?.maxOutputTokens ?? 0);
    const payloadHash = createHash("sha256").update(body).digest("hex");
    const target = new URL(`${targetBase.pathname.replace(/\/$/, "")}${incoming.url ?? "/"}`, targetBase.origin);
    const headers = forwardedHeaders(incoming.headers, body.length);
    const deadline = guard.deadline;
    for (let attempt = 0; ; attempt++) {
      if (guard.bounds) await (options.admission ?? new DeploymentAdmission()).admit(
        options.deployment ?? target.origin, tokens, guard.bounds.requestsPerMinute, guard.bounds.tokensPerMinute, deadline,
      );
      guard.claim(payloadHash);
      guard.reserve(body.length, tokens);
      dispatched = true;
      options.capture?.("runner.provider_dispatch", { request: guard.accounting.physicalRequests, reservedTokens: tokens });
      const response = await upstreamResponse(target, headers, body, Math.max(1, deadline - Date.now()));
      const status = response.statusCode ?? 502;
      if (status === 429) {
        guard.reject();
        guard.rejectedPayload(payloadHash);
        const delay = retryDelay({ get: (name) => String(response.headers[name] ?? "") || null }, attempt, Date.now());
        const reason = await rejectedReason(response);
        options.capture?.("runner.provider_rejected", { status, request: guard.accounting.physicalRequests, reason });
        if (attempt < (options.retries ?? 0) && Date.now() + delay < deadline) {
          if (reason === "permanent-quota") {
            guard.close();
            throw new DispatchError("Provider permanent quota exhaustion; no transient retry.", "explicitly-rejected", status);
          }
          dispatched = false;
          await new Promise((resolve) => setTimeout(resolve, delay)); continue;
        }
        guard.close();
        throw new DispatchError("Provider 429 rejection exhausted bounded physical-request recovery.", "explicitly-rejected", status);
      }
      if (status < 200 || status >= 300) {
        if (status >= 500) {
          response.resume();
          throw new DispatchError(`Provider ${status} failure may have processed the request; no replay.`, "possibly-processed", status);
        }
        guard.reject(); guard.close();
        const reason = await rejectedReason(response);
        options.capture?.("runner.provider_rejected", { status, request: guard.accounting.physicalRequests, reason });
        throw new DispatchError(`Provider rejected request (${status}, ${reason}); no identity fallback or retry.`, "explicitly-rejected", status);
      }
      const streaming = String(response.headers["content-type"] ?? "").includes("text/event-stream");
      if (!streaming) {
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of response) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > 16 * 1024 * 1024) { response.destroy(); throw new DispatchError("Provider response exceeds the 16 MiB byte bound.", "possibly-processed"); }
          chunks.push(buffer);
        }
        const reply = Buffer.concat(chunks);
        if (!isTerminalProviderResponse(incoming.url ?? "", JSON.parse(reply.toString("utf8")))) {
          throw new DispatchError("Malformed or nonterminal successful provider response; hidden replay denied.", "possibly-processed");
        }
        guard.certifyResponse();
        outgoing.writeHead(status, response.headers); outgoing.end(reply); return;
      }
      outgoing.writeHead(status, response.headers);
      await new Promise<void>((resolve, reject) => {
        let tail = "", completedStream = false, invalidStream = false;
        response.on("data", (chunk: Buffer) => {
          if (!streaming) return;
          tail += chunk.toString("utf8");
          const lines = tail.split(/\r?\n/);
          tail = lines.pop()!;
          if (tail.length > 16 * 1024 * 1024) {
            response.destroy(); reject(new DispatchError("Provider SSE event exceeds the 16 MiB byte bound.", "possibly-processed")); return;
          }
          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (!data) continue;
            if (data === "[DONE]") { completedStream = true; continue; }
            try {
              const event = JSON.parse(data) as { type?: unknown };
              if (event.type === "response.completed" || event.type === "message_stop") completedStream = true;
            } catch { invalidStream = true; }
          }
        });
        response.once("end", () => {
          if (invalidStream || !completedStream) reject(new DispatchError("Provider stream ended without valid completion evidence.", "possibly-processed"));
          else resolve();
        }); response.once("error", reject);
        response.once("aborted", () => reject(new DispatchError("Partial provider response.", "possibly-processed")));
        outgoing.once("close", () => { if (!response.complete) { response.destroy(); reject(new DispatchError("Downstream disconnected during provider response.", "possibly-processed")); } });
        response.pipe(outgoing);
      });
      guard.certifyResponse();
      return;
    }

    function isTerminalProviderResponse(route: string, value: unknown): boolean {
      if (!isRecord(value) || "error" in value || typeof value.id !== "string") return false;
      if (route.split("?")[0].endsWith("/responses")) return value.status === "completed" && Array.isArray(value.output);
      if (route.split("?")[0].endsWith("/messages")) return value.type === "message" && typeof value.stop_reason === "string" && Array.isArray(value.content);
      return Array.isArray(value.choices) && value.choices.length > 0
        && value.choices.every((choice) => isRecord(choice) && isRecord(choice.message) && typeof choice.finish_reason === "string");
    }

    function assertTextTokenReservation(value: unknown): void {
      if (Array.isArray(value)) { value.forEach(assertTextTokenReservation); return; }
      if (!isRecord(value)) return;
      if (typeof value.type === "string" && ["image", "image_url", "input_image", "input_audio", "audio", "video", "input_file", "file"].includes(value.type)) {
        throw new DispatchError("Bounded inference currently requires text-only request content; media token admission is not implemented.", "not-dispatched");
      }
      Object.values(value).forEach(assertTextTokenReservation);
    }
  } catch (error) {
    const certainty = error instanceof DispatchError ? error.certainty : dispatched ? "possibly-processed" : "not-dispatched";
    if (certainty === "possibly-processed") guard.ambiguous();
    options.capture?.("runner.provider_bridge_error", { certainty, status: error instanceof DispatchError ? error.status : null });
    if (!outgoing.headersSent && !outgoing.destroyed) {
      // Never hand a retryable 5xx back to a runtime with its own hidden retry layer.
      outgoing.writeHead(400, { "content-type": "application/json" });
    }
    if (!outgoing.destroyed) outgoing.end(JSON.stringify({ error: { message: error instanceof DispatchError ? error.message : `Provider bridge failure (${certainty}); request must not be replayed.`, type: "benchmark_bridge_error" } }));
  }
}

function upstreamResponse(target: URL, headers: IncomingHttpHeaders, body: Buffer, timeoutMs: number): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const forward = target.protocol === "https:" ? httpsRequest : httpRequest;
    const upstream = forward(target, { method: "POST", headers, signal: AbortSignal.timeout(timeoutMs) }, resolve);
    upstream.once("error", reject);
    upstream.end(body);
  });
}

function readRequestBody(incoming: IncomingMessage, limit = 10 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    incoming.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new DispatchError("Provider request exceeds the configured compatibility proxy byte limit.", "not-dispatched"));
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

export function executionProfile(config: BenchmarkConfig): RunContract["executionProfile"] {
  return {
    mode: config.isolation ? "container" : "trusted-local",
    ...(config.isolation ? { image: config.isolation.image } : {}),
    ...(config.requestBounds ? { requestBoundsHash: evidenceHash(config.requestBounds) } : {}),
  };
}

function materializeContract(config: BenchmarkConfig): RunContract {
  assertFoundryOnlyConfig(config);
  const runtime = readRuntimeIdentity();
  if (Object.entries(config.contract.runtime ?? {}).some(([key, value]) => value !== runtime[key as keyof typeof runtime])) {
    throw new DispatchError("Selected SDK/CLI executable identity differs from the prepared runtime; no work was dispatched.", "not-dispatched");
  }
  return {
    contractVersion: 2,
    task: config.contract.task,
    candidate: config.contract.candidate,
    execution: config.contract.execution,
    rounds: config.rounds.map((round) => ({ ...round })),
    runtime,
    foundryProvider: createFoundryProviderIdentity(config.contract.foundryProvider, process.env),
    executionProfile: executionProfile(config),
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
  return {
    type: config.type,
    baseUrl,
    ...providerAuthentication(config, environment, () => requiredEnvironmentValue("FOUNDRY_API_KEY", environment)),
    bearerToken: undefined,
    wireApi: config.type === "openai" ? config.wireApi ?? "completions" : undefined,
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
    ...(config.wireApi ? { wireApi: config.wireApi } : {}),
    ...(config.auth ? { auth: config.auth } : {}),
  };
}

export function requiredEnvironmentValue(
  name: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
    throw new TypeError(`Environment variable name "${name}" is invalid.`);
  }
  const value = environment[name]?.trim();
  if (!value) {
    if (name === "FOUNDRY_API_KEY") {
      const remediation = platform === "win32"
        ? '$env:FOUNDRY_API_KEY = "<your-foundry-api-key>"'
        : 'export FOUNDRY_API_KEY="<your-foundry-api-key>"';
      throw new Error(
        `FOUNDRY_API_KEY is required but is not set. Set it in the current shell session only: ${remediation}`,
      );
    }
    throw new Error(`Required Foundry environment variable "${name}" is not set.`);
  }
  return value;
}

export async function dispatchBenchmarkWorkRequests(
  requests: readonly BenchmarkWorkRequest[],
  send: (request: BenchmarkWorkRequest) => Promise<void>,
  retries: number,
  captureRunnerEvent: (eventType: string, data: JsonRecord) => void,
): Promise<void> {
  for (const request of requests) {
    captureRunnerEvent(
      request.kind === "task" ? "runner.task_started" : "runner.round_started",
      request.round === null ? {} : { round: request.round },
    );
    // A work request can contain multiple paid calls and non-idempotent tools.
    // Only the bridge may recover explicitly rejected physical requests.
    await send(request);
    captureRunnerEvent(
      request.kind === "task" ? "runner.task_finished" : "runner.round_finished",
      request.round === null ? {} : { round: request.round },
    );
  }
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
