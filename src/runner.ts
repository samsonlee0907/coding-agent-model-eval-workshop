import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { CopilotClient, approveAll, type CopilotSession } from "@github/copilot-sdk";
import { immutableContractHash } from "./contract.js";
import { EventCollector } from "./event-collector.js";
import { asRecord } from "./json.js";
import { deriveMetrics, extractModelCalls, extractToolCalls } from "./metrics.js";
import { classifyOutcome } from "./outcome.js";
import { writeRunReport } from "./report.js";
import type { BenchmarkConfig, BenchmarkRun, JsonRecord, RunContract } from "./types.js";
import { runValidation } from "./validation.js";

export async function runBenchmark(config: BenchmarkConfig): Promise<BenchmarkRun> {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const artifactsDirectory = resolve(config.artifactsDirectory ?? join(config.workspacePath, ".benchmark-artifacts"), runId);
  mkdirSync(artifactsDirectory, { recursive: true });
  const artifacts = {
    directory: artifactsDirectory,
    rawEvents: join(artifactsDirectory, "raw-events.ndjson"),
    normalizedEvents: join(artifactsDirectory, "normalized-events.ndjson"),
    report: join(artifactsDirectory, "report.md"),
  };
  const contract = materializeContract(config);
  assertSupportedPolicy(contract);
  const collector = new EventCollector(artifacts.rawEvents, artifacts.normalizedEvents);
  collector.captureRunnerEvent("runner.run_started", { runId });

  let sessionId: string | null = null;
  let validation = null;
  let runnerError: string | null = null;
  const client = new CopilotClient({ workingDirectory: config.workspacePath });
  let session: CopilotSession | null = null;

  try {
    await client.start();
    session = await client.createSession({
      model: contract.candidate.model,
      workingDirectory: config.workspacePath,
      streaming: true,
      systemMessage: { content: contract.execution.instructions },
      availableTools: contract.execution.tools,
      onPermissionRequest: contract.execution.permissionMode === "approve-all" ? approveAll : undefined,
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
    runnerError = error instanceof Error ? error.message : String(error);
    collector.captureRunnerEvent("runner.error", { message: runnerError });
  } finally {
    if (session) {
      await session.disconnect();
    }
    await client.stop();
  }

  validation = await runValidation(
    contract.task.validationCommand,
    config.workspacePath,
    contract.execution.sessionTimeoutMs,
  );
  collector.captureRunnerEvent("runner.validation_finished", asRecord(validation));
  collector.captureRunnerEvent("runner.run_finished", { runId });

  const events = collector.events();
  const modelCalls = extractModelCalls(events);
  const toolCalls = extractToolCalls(events);
  const run: BenchmarkRun = {
    runId,
    contract,
    contractHash: immutableContractHash(contract),
    sessionId,
    startedAt,
    completedAt: new Date().toISOString(),
    artifacts,
    modelCalls,
    toolCalls,
    usageMetrics: findUsageMetrics(events),
    validation,
    metrics: deriveMetrics(events, modelCalls),
    outcome: classifyOutcome({ validation, toolCalls, runnerError }),
    runnerError,
  };
  writeFileSync(join(artifactsDirectory, "run.json"), `${JSON.stringify(run, null, 2)}\n`, "utf8");
  writeRunReport(run);
  return run;
}

export function loadBenchmarkConfig(path: string): BenchmarkConfig {
  return JSON.parse(readFileSync(path, "utf8")) as BenchmarkConfig;
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
