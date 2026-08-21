import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runValidation } from "./validation.js";
import type {
  BenchmarkRun,
  ConformanceCheckResult,
  ConformanceCheckSpec,
  ConformanceProbeResult,
  ConformanceProbeSpec,
  ConformanceSeverity,
  ConformanceTotals,
  ValidationResult,
} from "./types.js";

/**
 * Runs a task-authored conformance probe against a delivered artifact.
 *
 * The validation command answers "do the candidate's own tests pass?" — which a
 * candidate can satisfy by writing agreeable tests. A probe answers a different
 * and stricter question: "does this artifact behave the way the task author
 * specified?" Because the checks are owned by the task and never shown to the
 * agent, passing them is evidence about the code rather than about the tests.
 *
 * Each check is an independent command so authoring one requires no output
 * format or reporting protocol: exit zero means the expectation held.
 */
export async function runConformanceProbe(
  spec: ConformanceProbeSpec,
  workspacePath: string,
  fallbackTimeoutMs: number,
): Promise<ConformanceProbeResult> {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const description = spec.description ?? null;
  const timeoutMs = spec.timeoutMs ?? fallbackTimeoutMs;

  if (spec.checks.length === 0) {
    return finalize(
      { available: false, reason: "The conformance probe declared no checks.", description, setup: null, checks: [] },
      startedAt,
      started,
    );
  }

  const setup = spec.setupCommand
    ? await runValidation(spec.setupCommand, workspacePath, timeoutMs)
    : null;

  // A failed setup makes every check result meaningless. Recording them as
  // `fail` would blame the artifact for a harness-side problem, so they are
  // recorded as `error` and the checks are not run at all.
  if (setup !== null && setup.exitCode !== 0) {
    return finalize(
      {
        available: true,
        reason: `Probe setup command failed (${describeExit(setup)}); checks were not run because their results could not be trusted.`,
        description,
        setup,
        checks: spec.checks.map((check) =>
          erroredCheck(check, `Setup failed before this check could run: ${describeExit(setup)}`),
        ),
      },
      startedAt,
      started,
    );
  }

  const checks: ConformanceCheckResult[] = [];
  for (const check of spec.checks) {
    const result = await runValidation(check.command, workspacePath, timeoutMs);
    checks.push(toCheckResult(check, result));
  }

  return finalize({ available: true, description, setup, checks }, startedAt, started);
}

/**
 * Loads a run's persisted probe result. Prefers the value embedded in
 * `run.json`, then the sidecar artifact, so a run recorded before probes
 * existed reports "not probed" instead of failing to load.
 */
export function loadConformanceProbe(run: BenchmarkRun): ConformanceProbeResult | null {
  if (run.conformance) {
    return run.conformance;
  }
  const candidate = run.artifacts.conformance
    ?? (run.artifacts.directory ? join(run.artifacts.directory, "conformance-probe.json") : null);
  if (candidate === null || !existsSync(candidate)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(candidate, "utf8")) as ConformanceProbeResult;
  } catch {
    return null;
  }
}

/** A run that validated green while failing a required expectation. */
export function divergesFromValidation(run: BenchmarkRun, probe: ConformanceProbeResult | null): boolean {
  return run.outcome.class === "resolved" && probe?.conformant === false;
}

export function summarizeConformance(probe: ConformanceProbeResult | null): string {
  if (probe === null) {
    return "Not probed";
  }
  if (!probe.available || probe.conformant === null) {
    return "Probe unavailable";
  }
  return probe.conformant ? "Conformant" : "Non-conformant";
}

function toCheckResult(check: ConformanceCheckSpec, result: ValidationResult): ConformanceCheckResult {
  const severity = check.severity ?? "required";
  return {
    id: check.id,
    description: check.description,
    command: check.command,
    severity,
    status: statusFor(severity, result),
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    stdout: result.stdout,
    stderr: result.stderr,
    errorMessage: result.errorMessage,
  };
}

/**
 * A check that could not be executed is never a failure of the artifact. Only a
 * command that ran to completion and exited non-zero is evidence against it.
 */
function statusFor(severity: ConformanceSeverity, result: ValidationResult): ConformanceCheckResult["status"] {
  if (result.errorMessage !== null || result.exitCode === null) {
    return "error";
  }
  if (result.exitCode === 0) {
    return "pass";
  }
  return severity === "advisory" ? "weak" : "fail";
}

function erroredCheck(check: ConformanceCheckSpec, reason: string): ConformanceCheckResult {
  return {
    id: check.id,
    description: check.description,
    command: check.command,
    severity: check.severity ?? "required",
    status: "error",
    exitCode: null,
    timedOut: false,
    durationMs: 0,
    stdout: "",
    stderr: "",
    errorMessage: reason,
  };
}

function finalize(
  partial: {
    available: boolean;
    reason?: string;
    description: string | null;
    setup: ValidationResult | null;
    checks: ConformanceCheckResult[];
  },
  startedAt: string,
  started: number,
): ConformanceProbeResult {
  const totals = tally(partial.checks);
  const required = partial.checks.filter((check) => check.severity === "required");
  // A required check that could not be executed leaves the verdict inconclusive
  // rather than damning: absence of evidence is not evidence of a defect.
  const conclusive =
    partial.available && required.length > 0 && required.every((check) => check.status !== "error");
  return {
    available: partial.available,
    ...(partial.reason === undefined ? {} : { reason: partial.reason }),
    description: partial.description,
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    setup: partial.setup,
    checks: partial.checks,
    totals,
    conformant: conclusive ? required.every((check) => check.status === "pass") : null,
  };
}

function tally(checks: readonly ConformanceCheckResult[]): ConformanceTotals {
  return {
    total: checks.length,
    passed: checks.filter((check) => check.status === "pass").length,
    weak: checks.filter((check) => check.status === "weak").length,
    failed: checks.filter((check) => check.status === "fail").length,
    errored: checks.filter((check) => check.status === "error").length,
  };
}

function describeExit(result: ValidationResult): string {
  if (result.timedOut) {
    return "timed out";
  }
  if (result.errorMessage !== null) {
    return result.errorMessage;
  }
  return `exit code ${result.exitCode ?? "unknown"}`;
}
