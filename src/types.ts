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

export type ToolCapability = "read" | "edit" | "shell";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * A local (stdio) MCP server the agent may call during a run. Structurally
 * compatible with the Copilot SDK's `MCPStdioServerConfig`, but kept as a
 * project-owned type so the config surface stays adapter-tolerant.
 *
 * Secret-bearing string values (env, args) may use `${ENV_VAR}` placeholders.
 * The runner expands them from the process environment at launch, so config
 * files and the immutable contract never store raw credentials.
 */
export interface McpStdioServerSpec {
  type?: "stdio" | "local";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  workingDirectory?: string;
  /** Tools to include from this server. Omit or `["*"]` for all; `[]` for none. */
  tools?: string[];
  timeout?: number;
}

/**
 * A remote (HTTP/SSE) MCP server. Structurally compatible with the SDK's
 * `MCPHTTPServerConfig`. `url` and `headers` values may use `${ENV_VAR}`
 * placeholders resolved at launch.
 */
export interface McpHttpServerSpec {
  type: "http" | "sse";
  url: string;
  headers?: Record<string, string>;
  tools?: string[];
  timeout?: number;
}

export type McpServerSpec = McpStdioServerSpec | McpHttpServerSpec;

export interface ExecutionPolicy {
  instructions: string;
  tools: ToolCapability[];
  permissionMode: "approve-all" | "manual";
  concurrency: number;
  retries: number;
  sessionTimeoutMs: number;
  streaming: true;
  cachePolicy: "default" | "disabled" | "required";
  reasoningEffort: ReasoningEffort;
  /**
   * Optional Model Context Protocol servers to make available to the agent, in
   * addition to the built-in `read | edit | shell` tools. Keyed by server name.
   * Omit entirely to keep the default tool scope; presence becomes part of the
   * immutable contract, so runs with different MCP access are not strictly
   * comparable.
   */
  mcpServers?: Record<string, McpServerSpec>;
}

export interface RuntimeIdentity {
  sdkVersion: string;
  cliVersion: string;
  nodeVersion: string;
}

export type FoundryProviderType = "openai" | "anthropic";

/**
 * Foundry-only provider selection. The runner always reads the canonical
 * resource root and credential from FOUNDRY_ENDPOINT and FOUNDRY_API_KEY.
 */
export interface FoundryProviderConfig {
  type: FoundryProviderType;
}

/**
 * Safe Foundry provider identity persisted in a run contract. The endpoint is
 * fingerprinted so traces never disclose its raw URL or credential.
 */
export interface FoundryProviderIdentity {
  type: FoundryProviderType;
  endpointFingerprint: string;
  requestAdaptation: "openai-null-refusal-sanitizer" | "strip-temperature";
}

export interface RunContract {
  contractVersion: 1;
  task: TaskContract;
  candidate: CandidateContract;
  execution: ExecutionPolicy;
  runtime: RuntimeIdentity;
  foundryProvider?: FoundryProviderIdentity;
}

export interface ComparisonContract {
  contractVersion: 1;
  comparisonId: string;
  sharedTask: TaskContract;
  sharedExecution: ExecutionPolicy;
  candidates: [CandidateContract, CandidateContract];
}

export interface BenchmarkConfig {
  contract: Omit<RunContract, "contractVersion" | "runtime" | "foundryProvider"> & {
    runtime?: Partial<RuntimeIdentity>;
    foundryProvider: FoundryProviderConfig;
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
  stdout: string;
  stderr: string;
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
    diagnostics: string;
    report: string;
  };
  diagnostics: RunDiagnostics;
  modelCalls: ModelCall[];
  toolCalls: ToolCall[];
  usageMetrics: JsonRecord | null;
  validation: ValidationResult | null;
  metrics: DerivedMetrics;
  outcome: Outcome;
  runnerError: string | null;
}

export interface LlmJudgeConfig {
  provider: FoundryProviderConfig;
  model: string;
  reasoningEffort: ReasoningEffort;
  timeoutMs: number;
}

export interface LlmJudgeScore {
  runId: string;
  candidate: string;
  codeQuality: number;
  requirementCoverage: number;
  maintainability: number;
  evidenceConfidence: "low" | "medium" | "high";
  rationale: string;
  risks: string[];
}

export interface LlmEvaluationResult {
  schemaVersion: 1;
  createdAt: string;
  judge: FoundryProviderIdentity & {
    model: string;
    reasoningEffort: ReasoningEffort;
    promptVersion: "benchmark-judge-v1";
  };
  evaluatedRunIds: string[];
  scores: LlmJudgeScore[];
  comparisonSummary: string;
  limitations: string[];
  rawResponse: string;
}

export interface RunDiagnostics {
  schemaVersion: 1;
  runtime: RuntimeIdentity;
  selectedModel: string | null;
  configuredToolFilters: string[];
  configurationMessages: string[];
  providerFailure: {
    httpStatus: number | null;
    signature: "anthropic_temperature_deprecated" | "provider_resource_not_found" | "other" | null;
    message: string | null;
  };
}
