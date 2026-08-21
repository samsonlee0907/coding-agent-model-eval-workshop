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

test("diagnostics identify an Azure/Foundry resource with key-based auth disabled, even mid-session", () => {
  // The generic session-level error the CLI surfaces (captured as runnerError)
  // never mentions the provider's actual error code; the real signal lives in
  // the raw model.call_failure event emitted on the turn that first failed,
  // which can be several successful turns into an otherwise-healthy session.
  const eventsWithMidSessionAuthFailure: NormalizedEvent[] = [
    ...events,
    {
      schemaVersion: 1,
      sequence: 3,
      recordedAt: "2026-08-21T03:30:36.151Z",
      source: "sdk",
      eventType: "model.call_failure",
      eventId: null,
      parentEventId: null,
      agentId: null,
      eventTimestamp: null,
      ephemeral: true,
      data: {
        model: "FW-Kimi-K3",
        statusCode: 403,
        errorMessage: '{"code":"AuthenticationTypeDisabled","message":"Key based authentication is disabled for this resource."}',
      },
    },
  ];
  const diagnostics = createRunDiagnostics(
    eventsWithMidSessionAuthFailure,
    runtime,
    ["builtin:view"],
    "Authentication failed with provider at <redacted-provider-url> (HTTP 403).\n  Check your COPILOT_PROVIDER_API_KEY or COPILOT_PROVIDER_BEARER_TOKEN.",
  );
  assert.equal(diagnostics.providerFailure.httpStatus, 403);
  assert.equal(diagnostics.providerFailure.signature, "azure_key_auth_disabled");
});
