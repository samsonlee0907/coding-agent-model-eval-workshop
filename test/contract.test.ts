import assert from "node:assert/strict";
import test from "node:test";
import { compareRunContractSet, compareRunContracts, createComparisonContract, immutableContractHash } from "../src/contract.js";
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

test("differing MCP tool access makes a comparison not strictly comparable", () => {
  const left = contract();
  const right = contract();
  right.execution.mcpServers = {
    fetch: { command: "npx", args: ["-y", "mcp-server-fetch"] },
  };

  const comparison = compareRunContracts(left, right);
  assert.equal(comparison.strictlyComparable, false);
  assert.equal(
    comparison.drift.some((entry) => entry.path.startsWith("execution.mcpServers")),
    true,
  );
  // Adding the field must change the immutable contract identity.
  assert.notEqual(immutableContractHash(left), immutableContractHash(right));
});

test("configuring identical MCP servers stays strictly comparable and stable", () => {
  const left = contract();
  const right = contract();
  const servers = { fetch: { command: "npx", args: ["-y", "mcp-server-fetch"] } };
  left.execution.mcpServers = { ...servers };
  right.execution.mcpServers = { ...servers };

  assert.equal(compareRunContracts(left, right).strictlyComparable, true);
  assert.equal(immutableContractHash(left), immutableContractHash(right));
});

test("compares more than two candidates against a shared baseline", () => {
  const a = contract();
  const b = contract();
  const c = contract();
  b.candidate = { provider: "foundry", model: "model-b" };
  c.candidate = { provider: "foundry", model: "model-c" };

  const comparable = compareRunContractSet([a, b, c]);
  assert.equal(comparable.strictlyComparable, true);
  assert.equal(comparable.drift.length, 0);

  const comparison = createComparisonContract("cmp-1", [a, b, c]);
  assert.equal(comparison.candidates.length, 3);
  assert.deepEqual(comparison.candidates.map((candidate) => candidate.model), ["gpt-test", "model-b", "model-c"]);
});

test("attributes set-comparison drift to the diverging candidate", () => {
  const a = contract();
  const b = contract();
  const c = contract();
  c.execution.reasoningEffort = "low";

  const comparison = compareRunContractSet([a, b, c]);
  assert.equal(comparison.strictlyComparable, false);
  assert.equal(
    comparison.drift.some((entry) => entry.path === "candidate[2].execution.reasoningEffort"),
    true,
  );
});

test("createComparisonContract rejects fewer than two candidates", () => {
  assert.throws(() => createComparisonContract("cmp-1", [contract()]), /at least two candidates/);
});
