import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { freemem } from "node:os";
import { benchmarkConfigSchema } from "./config-schema.js";
import { deriveFoundryInferenceBase } from "./foundry-endpoint.js";
import { resolveFoundryProvider } from "./runner.js";
import { readRuntimeIdentity } from "./runtime-identity.js";
import { executeDocker } from "./controlled-worker.js";
import { inferenceDiagnostic } from "./auth.js";

export async function doctor(configPath: string, acquireAuth = false) {
  const config = benchmarkConfigSchema.parse(JSON.parse(readFileSync(configPath, "utf8")));
  const workspace = resolve(dirname(configPath), config.workspacePath);
  const checks: Array<{ stage: string; status: "pass" | "fail" | "not-verified"; detail: string }> = [];
  try {
    if (!existsSync(workspace)) throw new Error("Workspace is missing.");
    accessSync(workspace, constants.R_OK | constants.W_OK);
    checks.push({ stage: "workspace", status: "pass", detail: "Workspace is readable/writable. Outputs require their own owned destination." });
  } catch {
    checks.push({ stage: "workspace", status: "fail", detail: "Workspace path is missing or not readable/writable." });
  }
  try {
    const runtime = readRuntimeIdentity();
    checks.push({ stage: "runtime", status: "pass", detail: JSON.stringify(runtime) });
  } catch (error) {
    checks.push({ stage: "runtime", status: "fail", detail: error instanceof Error ? error.message : String(error) });
  }
  checks.push({ stage: "host-capacity", status: "pass", detail: `${Math.floor(freemem() / 1024 / 1024)} MiB free host memory; campaign admission uses its configured bound.` });
  if (process.env.FOUNDRY_ENDPOINT) {
    try {
      deriveFoundryInferenceBase(process.env.FOUNDRY_ENDPOINT, config.contract.foundryProvider.type);
      checks.push({ stage: "endpoint", status: "pass", detail: "Canonical resource root syntax checked; deployment/network permissions are not inferred." });
    } catch {
      checks.push({ stage: "endpoint", status: "fail", detail: "FOUNDRY_ENDPOINT must be a canonical HTTPS Foundry resource root." });
    }
  } else checks.push({ stage: "endpoint", status: "not-verified", detail: "FOUNDRY_ENDPOINT is absent. Offline preparation/reporting does not require it." });
  if (config.isolation) {
    for (const [stage, args] of [["container-daemon", ["version", "--format", "{{.Server.Version}}"]], ["pinned-image", ["image", "inspect", config.isolation.image]]] as const) {
      try {
        const result = await executeDocker(args);
        checks.push({ stage, status: result.code === 0 ? "pass" : "fail", detail: result.code === 0 ? "Prerequisite available (no image pulled or container started)." : "Docker daemon or explicit pinned local image is unavailable; no trusted-host fallback." });
      } catch {
        checks.push({ stage, status: "fail", detail: "Docker prerequisite unavailable; no trusted-host fallback." });
      }
    }
  } else checks.push({ stage: "execution-boundary", status: "not-verified", detail: "TRUSTED LOCAL: candidate tools/validators can access host files, identity caches and resources. Environment scrubbing is not isolation." });
  if (acquireAuth) {
    try {
      const provider = resolveFoundryProvider(config.contract.foundryProvider, process.env);
      if (provider.bearerTokenProvider) await provider.bearerTokenProvider({ providerName: config.contract.foundryProvider.type, sessionId: "doctor-no-inference" });
      checks.push({ stage: "credential-acquisition", status: "pass", detail: provider.bearerTokenProvider ? "Selected Entra credential acquired a token; no inference sent and no token recorded." : "Key present in process; validity/key-enabled policy NOT verified." });
    } catch (error) {
      checks.push({ stage: "credential-acquisition", status: "fail", detail: error instanceof Error ? error.message : String(error) });
    }
  } else checks.push({ stage: "credential-acquisition", status: "not-verified", detail: "Not attempted. Use --acquire-auth for an explicit token-only network check." });
  checks.push({ stage: "data-plane-inference", status: "not-verified", detail: "No model call made. Token acquisition and management login do not certify inference RBAC, deployment, private network or quota." });
  return {
    schemaVersion: 1, auth: config.contract.foundryProvider.auth ?? { mode: "key" },
    wireApi: config.contract.foundryProvider.wireApi ?? (config.contract.foundryProvider.type === "openai" ? "completions" : "messages"),
    localChecksPassed: checks.every((check) => check.status !== "fail"), checks,
    diagnostics: [401, 403, 404, 429].map((status) => ({ status, guidance: inferenceDiagnostic(status) })),
  };
}
