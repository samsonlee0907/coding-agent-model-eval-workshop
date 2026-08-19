import assert from "node:assert/strict";
import test from "node:test";
import { createRunDiagnostics } from "../src/runner.js";
import type { NormalizedEvent, RuntimeIdentity } from "../src/types.js";

const runtime: RuntimeIdentity = {
  sdkVersion: "1.0.10-preview.0",
  cliVersion: "1.0.80",
  nodeVersion: "v26",
};

const events: NormalizedEvent[] = [
  {
    schemaVersion: 1,
    sequence: 1,
    recordedAt: "2026-08-19T00:00:00.000Z",
    source: "sdk",
    eventType: "session.start",
    eventId: null,
    parentEventId: null,
    agentId: null,
    eventTimestamp: null,
    ephemeral: null,
    data: { selectedModel: "claude-sonnet-5" },
  },
  {
    schemaVersion: 1,
    sequence: 2,
    recordedAt: "2026-08-19T00:00:00.000Z",
    source: "sdk",
    eventType: "session.info",
    eventId: null,
    parentEventId: null,
    agentId: null,
    eventTimestamp: null,
    ephemeral: null,
    data: { infoType: "configuration", message: "Disabled tools: web_fetch" },
  },
];

test("diagnostics identify the Foundry Claude temperature incompatibility", () => {
  const diagnostics = createRunDiagnostics(
    events,
    runtime,
    ["builtin:view", "builtin:edit"],
    "400 `temperature` is deprecated for this model.",
  );
  assert.equal(diagnostics.selectedModel, "claude-sonnet-5");
  assert.equal(diagnostics.providerFailure.httpStatus, 400);
  assert.equal(diagnostics.providerFailure.signature, "anthropic_temperature_deprecated");
  assert.deepEqual(diagnostics.configurationMessages, ["Disabled tools: web_fetch"]);
});

test("diagnostics identify a provider endpoint or deployment lookup failure", () => {
  const diagnostics = createRunDiagnostics(
    events,
    runtime,
    ["builtin:view"],
    "Resource not found on provider at <redacted-provider-url> (HTTP 404).",
  );
  assert.equal(diagnostics.providerFailure.httpStatus, 404);
  assert.equal(diagnostics.providerFailure.signature, "provider_resource_not_found");
});
