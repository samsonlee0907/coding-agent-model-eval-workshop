import assert from "node:assert/strict";
import test from "node:test";
import { compareRunContracts, immutableContractHash } from "../src/contract.js";
import type { RunContract } from "../src/types.js";

function contract(): RunContract {
  return {
    contractVersion: 1,
    task: {
      id: "task-1",
      prompt: "Fix the parser.",
      repository: { commitSha: "abc123", containerFingerprint: "container:v1" },
      validationCommand: "npm test",
    },
    candidate: { provider: "github", model: "gpt-test" },
    execution: {
      instructions: "Work in rounds.",
      tools: ["read", "edit", "shell"],
      permissionMode: "approve-all",
      concurrency: 1,
      retries: 0,
      sessionTimeoutMs: 60_000,
      streaming: true,
      cachePolicy: "default",
      reasoningEffort: "high",
    },
    runtime: { sdkVersion: "1.0.10", cliVersion: "1.2.3", nodeVersion: "v22" },
  };
}

test("run contracts are deterministic and detect policy drift", () => {
  const left = contract();
  const right = contract();
  assert.equal(immutableContractHash(left), immutableContractHash(right));
  assert.equal(compareRunContracts(left, right).strictlyComparable, true);

  right.execution.cachePolicy = "disabled";
  const comparison = compareRunContracts(left, right);
  assert.equal(comparison.strictlyComparable, false);
  assert.equal(comparison.drift[0]?.path, "execution.cachePolicy");
});

test("wire adaptation is strict-comparison drift", () => {
  const left = contract();
  const right = contract();
  left.foundryProvider = {
    type: "anthropic",
    endpointFingerprint: "one",
    requestAdaptation: "strip-temperature",
  };
  right.foundryProvider = { type: "openai", endpointFingerprint: "one", requestAdaptation: "openai-null-refusal-sanitizer" };

  const comparison = compareRunContracts(left, right);
  assert.equal(comparison.strictlyComparable, false);
  assert.equal(comparison.drift[0]?.path, "foundryProvider.requestAdaptation");
});
