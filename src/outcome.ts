import type { Outcome, ToolCall, ValidationResult } from "./types.js";

export interface OutcomeFacts {
  validation: ValidationResult | null;
  toolCalls: readonly ToolCall[];
  runnerError: string | null;
}

export function classifyOutcome(facts: OutcomeFacts): Outcome {
  if (facts.validation?.errorMessage) {
    return agentOutcome("harness_failure", facts.validation.errorMessage);
  }
  if (facts.validation?.exitCode === 0) {
    return deterministicOutcome("resolved", "Configured deterministic validation command exited with status 0.");
  }
  if (facts.validation && (facts.validation.timedOut || facts.validation.exitCode !== 0)) {
    return deterministicOutcome("unresolved", facts.validation.timedOut
      ? "Configured deterministic validation command timed out."
      : `Configured deterministic validation command exited with status ${facts.validation.exitCode}.`);
  }

  const evidence = [facts.runnerError, ...facts.toolCalls.map((call) => call.error)].filter(
    (value): value is string => Boolean(value),
  ).join(" ");
  if (/rate.?limit|429|quota/i.test(evidence)) {
    return agentOutcome("rate_limit", "Runtime evidence indicates a rate-limit or quota outcome.");
  }
  if (/timeout|timed out/i.test(evidence)) {
    return agentOutcome("timeout", "Runtime evidence indicates an agent or tool timeout.");
  }
  if (facts.toolCalls.some((call) => call.resultType === "failure" || call.resultType === "timeout")) {
    return agentOutcome("tool_container_failure", "A tool execution failed and no deterministic evaluator result was recorded.");
  }
  if (facts.toolCalls.length === 0 || !facts.toolCalls.some((call) => isEditTool(call.toolName))) {
    return agentOutcome("empty_patch", "No edit-like tool execution was observed; this is not a deterministic resolution result.");
  }
  return agentOutcome("harness_failure", facts.runnerError ?? "No validation result was recorded.");
}

function deterministicOutcome(outcomeClass: "resolved" | "unresolved", detail: string): Outcome {
  return { class: outcomeClass, category: "deterministic-evaluator", detail };
}

function agentOutcome(outcomeClass: Exclude<Outcome["class"], "resolved" | "unresolved">, detail: string): Outcome {
  return { class: outcomeClass, category: "agent-or-infrastructure", detail };
}

function isEditTool(name: string | null): boolean {
  return name !== null && /(edit|write|apply_patch|create_file)/i.test(name);
}
