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
  /**
   * Optional task-authored conformance probe. Validation runs the *candidate's
   * own* test command, which only proves the candidate agrees with itself. A
   * probe is owned by the task author and exercises the delivered artifact
   * against expectations the candidate never saw, so it can distinguish
   * "the agent's tests pass" from "this meets the specification".
   *
   * Part of the immutable contract: two runs probed differently are not
   * strictly comparable.
   */
  conformanceProbe?: ConformanceProbeSpec;
}

/** Whether a failing check means non-conformance or is merely a signal. */
export type ConformanceSeverity = "required" | "advisory";

export interface ConformanceCheckSpec {
  /** Stable identifier, used to join results across runs. */
  id: string;
  /** What this check establishes, in the task author's words. */
  description: string;
  /** Shell command run in the delivered workspace. Exit 0 means the check held. */
  command: string;
  /** Defaults to `"required"`. */
  severity?: ConformanceSeverity;
}

export interface ConformanceProbeSpec {
  description?: string;
  /**
   * Optional command run once before the checks (dependency install, build).
   * When it fails, no check result can be trusted, so every check is recorded
   * as `error` rather than `fail` — an unbuildable artifact is not the same
   * evidence as a wrong one.
   */
  setupCommand?: string;
  /** Per-command timeout. Falls back to the session timeout when omitted. */
  timeoutMs?: number;
  checks: ConformanceCheckSpec[];
}

export type ConformanceCheckStatus = "pass" | "weak" | "fail" | "error";

export interface ConformanceCheckResult {
  id: string;
  description: string;
  command: string;
  severity: ConformanceSeverity;
  status: ConformanceCheckStatus;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  errorMessage: string | null;
}

export interface ConformanceTotals {
  total: number;
  passed: number;
  weak: number;
  failed: number;
  errored: number;
}

export interface ConformanceProbeResult {
  /** False when the task declared no probe, or the probe could not be run. */
  available: boolean;
  reason?: string;
  description: string | null;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  setup: ValidationResult | null;
  checks: ConformanceCheckResult[];
  totals: ConformanceTotals;
  /**
   * True only when the probe ran and every required check passed. Deliberately
   * separate from `outcome`: the outcome class stays anchored to the configured
   * validation command so existing runs remain comparable, while this records
   * whether the artifact actually met the task author's expectations.
   */
  conformant: boolean | null;
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
  /** Two or more candidates evaluated against the same shared task/execution. */
  candidates: CandidateContract[];
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
    /**
     * Source-only unified diff of the agent's changes vs the task baseline
     * commit (`changes.patch`). Optional so runs recorded before diff capture
     * existed still parse; when absent, consumers fall back to
     * `<directory>/changes.patch` or treat the code diff as unavailable.
     */
    changes?: string;
    /**
     * The task workspace this run produced. Optional so earlier runs still
     * parse; when present it lets consumers re-inspect the final code artifact.
     */
    workspace?: string;
    /** Persisted `artifact-inspection.json`, when the artifact was inspected. */
    inspection?: string;
    /** Persisted `conformance-probe.json`, when the task declared a probe. */
    conformance?: string;
  };
  diagnostics: RunDiagnostics;
  modelCalls: ModelCall[];
  toolCalls: ToolCall[];
  usageMetrics: JsonRecord | null;
  validation: ValidationResult | null;
  /**
   * Task-authored conformance evidence. Optional so every run recorded before
   * probes existed still parses; absent means "not probed", which the report
   * states rather than treating as a pass.
   */
  conformance?: ConformanceProbeResult;
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

export type InspectedFileRole = "source" | "test" | "config" | "doc" | "other";

export interface InspectedFile {
  path: string;
  role: InspectedFileRole;
  /** True when the file lives under a compiler/bundler output directory. */
  underBuildOutput: boolean;
  bytes: number;
  lines: number | null;
  sha256: string | null;
}

export interface ArtifactSourceFile {
  path: string;
  role: InspectedFileRole;
  lines: number;
  truncated: boolean;
  content: string;
}

export interface EntryPointCheck {
  /** Manifest field, e.g. `main`, `types`, `bin.cli`, `exports["."].import`. */
  field: string;
  declared: string;
  resolvedPath: string | null;
  exists: boolean;
}

export interface DependencyDrift {
  name: string;
  scope: "dependencies" | "devDependencies";
  declared: string;
  /** Version found in `node_modules`, or null when the package is absent. */
  installed: string | null;
  /** `null` when the declared range form was not evaluated. */
  satisfied: boolean | null;
  installedIsPrerelease: boolean;
}

export interface ExportedSymbol {
  file: string;
  kind: "function" | "class" | "const" | "let" | "var" | "interface" | "type" | "enum";
  symbol: string;
}

/**
 * Deterministic evidence about the code a run actually produced. Distinct from
 * the diff: this is the artifact's *final* state plus integrity checks that a
 * green validation command can hide (unresolvable entry points, dependency
 * drift, test files collected from build output).
 */
export interface ArtifactInspection {
  schemaVersion: 1;
  capturedAt: string;
  root: string;
  available: boolean;
  reason?: string;
  files: InspectedFile[];
  totals: {
    files: number;
    buildOutputFiles: number;
    sourceFiles: number;
    testFiles: number;
    sourceLines: number;
    testLines: number;
  };
  /** Verbatim `package.json`, or null when the workspace has none. */
  manifest: string | null;
  entryPoints: EntryPointCheck[];
  dependencyDrift: DependencyDrift[];
  testFilesUnderBuildOutput: string[];
  exports: ExportedSymbol[];
  sources: ArtifactSourceFile[];
}

export type JudgeFindingSeverity = "high" | "medium" | "low";
export type JudgeFindingCategory =
  | "correctness"
  | "test-adequacy"
  | "api-design"
  | "maintainability"
  | "reproducibility"
  | "requirement-gap";

/**
 * A single reviewer claim anchored to a specific line of inspected code.
 * `citationVerified` is set by the harness, not the judge: it records whether
 * the cited file and line actually exist in the inspected artifact, so
 * unanchored claims stay visible instead of reading as fact.
 */
export interface JudgeFinding {
  file: string;
  line: number | null;
  severity: JudgeFindingSeverity;
  category: JudgeFindingCategory;
  claim: string;
  evidence: string;
  citationVerified: boolean;
}

export interface LlmJudgeScore {
  runId: string;
  candidate: string;
  codeQuality: number;
  requirementCoverage: number;
  maintainability: number;
  /** Judge dimensions added in `benchmark-judge-v3`; absent on earlier artifacts. */
  correctness?: number;
  testAdequacy?: number;
  apiDesign?: number;
  reproducibility?: number;
  evidenceConfidence: "low" | "medium" | "high";
  /** Files the judge states it reviewed, so coverage is auditable. */
  reviewedFiles?: string[];
  findings?: JudgeFinding[];
  rationale: string;
  risks: string[];
}

/** A cross-candidate observation that per-run scoring structurally cannot produce. */
export interface ComparativeInsight {
  theme: string;
  observation: string;
  candidates: string[];
}

export interface LlmEvaluationResult {
  schemaVersion: 1;
  createdAt: string;
  judge: FoundryProviderIdentity & {
    model: string;
    reasoningEffort: ReasoningEffort;
    promptVersion: "benchmark-judge-v1" | "benchmark-judge-v2" | "benchmark-judge-v3";
  };
  evaluatedRunIds: string[];
  scores: LlmJudgeScore[];
  /** Cross-candidate divergences; absent on artifacts produced before v3. */
  comparativeInsights?: ComparativeInsight[];
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
    signature:
      | "anthropic_temperature_deprecated"
      | "provider_resource_not_found"
      | "azure_key_auth_disabled"
      | "other"
      | null;
    message: string | null;
  };
}
