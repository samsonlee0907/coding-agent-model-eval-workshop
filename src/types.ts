export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonRecord = { [key: string]: JsonValue };

export interface RepositoryContract {
  url?: string;
  commitSha: string;
  containerFingerprint: string;
}

export interface TaskContract {
  id: string;
  prompt: string;
  repository: RepositoryContract;
  validationCommand: string;
}

export interface CandidateContract {
  provider: string;
  model: string;
  deployment?: string;
}

export interface ExecutionPolicy {
  instructions: string;
  tools: string[];
  permissionMode: "approve-all" | "manual";
  concurrency: number;
  retries: number;
  sessionTimeoutMs: number;
  streaming: true;
  cachePolicy: "default" | "disabled" | "required";
}

export interface RuntimeIdentity {
  sdkVersion: string;
  cliVersion: string;
  nodeVersion: string;
}

export interface RunContract {
  contractVersion: 1;
  task: TaskContract;
  candidate: CandidateContract;
  execution: ExecutionPolicy;
  runtime: RuntimeIdentity;
}

export interface ComparisonContract {
  contractVersion: 1;
  comparisonId: string;
  sharedTask: TaskContract;
  sharedExecution: ExecutionPolicy;
  candidates: [CandidateContract, CandidateContract];
}

export interface BenchmarkConfig {
  contract: Omit<RunContract, "contractVersion" | "runtime"> & {
    runtime?: Partial<RuntimeIdentity>;
  };
  rounds: Array<{ prompt: string; mode?: "enqueue" | "immediate" }>;
  workspacePath: string;
  artifactsDirectory?: string;
}

export interface RawEventRecord {
  schemaVersion: 1;
  sequence: number;
  receivedAt: string;
  source: "sdk" | "runner";
  envelope: JsonValue;
}

export interface NormalizedEvent {
  schemaVersion: 1;
  sequence: number;
  recordedAt: string;
  source: "sdk" | "runner";
  eventType: string;
  eventId: string | null;
  parentEventId: string | null;
  agentId: string | null;
  eventTimestamp: string | null;
  ephemeral: boolean | null;
  data: JsonRecord;
}

export interface ModelCall {
  eventId: string | null;
  agentId: string | null;
  timestamp: string;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  cost: number | null;
  durationMs: number | null;
  sdkTimeToFirstTokenMs: number | null;
  sdkInterTokenLatencyMs: number | null;
  finishReason: string | null;
}

export interface ToolCall {
  toolCallId: string | null;
  toolName: string | null;
  agentId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  resultType: string | null;
  error: string | null;
}

export interface ValidationResult {
  command: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  exitCode: number | null;
  timedOut: boolean;
  errorMessage: string | null;
}

export type MetricStatus = "available" | "unavailable";
export interface Metric<T> {
  status: MetricStatus;
  value: T | null;
  source?: string;
  reason?: string;
}

export interface DerivedMetrics {
  e2eMs: Metric<number>;
  timeToFirstToolCallMs: Metric<number>;
  timeToFirstEditMs: Metric<number>;
  timeToGreenTestMs: Metric<number>;
  timeToFirstTokenMs: Metric<number>;
  timePerOutputTokenMs: Metric<number>;
  inputTokens: Metric<number>;
  outputTokens: Metric<number>;
  cacheReadTokens: Metric<number>;
  cacheWriteTokens: Metric<number>;
  cost: Metric<number>;
}

export type OutcomeClass =
  | "resolved"
  | "unresolved"
  | "empty_patch"
  | "rate_limit"
  | "timeout"
  | "tool_container_failure"
  | "harness_failure";

export interface Outcome {
  class: OutcomeClass;
  category: "deterministic-evaluator" | "agent-or-infrastructure";
  detail: string;
}

export interface BenchmarkRun {
  runId: string;
  contract: RunContract;
  contractHash: string;
  sessionId: string | null;
  startedAt: string;
  completedAt: string;
  artifacts: {
    directory: string;
    rawEvents: string;
    normalizedEvents: string;
    report: string;
  };
  modelCalls: ModelCall[];
  toolCalls: ToolCall[];
  usageMetrics: JsonRecord | null;
  validation: ValidationResult | null;
  metrics: DerivedMetrics;
  outcome: Outcome;
  runnerError: string | null;
}
