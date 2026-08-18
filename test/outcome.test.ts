import assert from "node:assert/strict";
import test from "node:test";
import { classifyOutcome } from "../src/outcome.js";
import type { ValidationResult } from "../src/types.js";

function validation(exitCode: number | null): ValidationResult {
  return {
    command: "npm test",
    startedAt: "2026-08-18T00:00:00.000Z",
    completedAt: "2026-08-18T00:00:01.000Z",
    durationMs: 1_000,
    exitCode,
    timedOut: false,
    errorMessage: null,
  };
}

test("deterministic evaluator results take precedence after a completed validation", () => {
  assert.equal(classifyOutcome({ validation: validation(0), toolCalls: [], runnerError: "tool failed earlier" }).class, "resolved");
  assert.equal(classifyOutcome({ validation: validation(1), toolCalls: [], runnerError: null }).class, "unresolved");
});

test("agent and infrastructure outcomes remain explicit without validation", () => {
  assert.equal(classifyOutcome({ validation: null, toolCalls: [], runnerError: "HTTP 429 rate limit" }).class, "rate_limit");
  assert.equal(classifyOutcome({ validation: null, toolCalls: [], runnerError: null }).class, "empty_patch");
});
