import { createHash } from "node:crypto";
import { z } from "zod";
import { deriveFoundryInferenceBase } from "./foundry-endpoint.js";
import type { BenchmarkConfig, FoundryProviderConfig } from "./types.js";

export const deploymentCapacitySchema = z.object({
  source: z.enum(["administrator-declared", "azure-management-observation"]),
  observedAt: z.string().datetime(),
  endpoint: z.string().min(1),
  deployment: z.string().min(1),
  wireApi: z.enum(["responses", "completions", "messages"]),
  requestsPerMinute: z.number().int().positive(),
  tokensPerMinute: z.number().int().positive(),
}).strict();

export function capacityIdentity(provider: FoundryProviderConfig) {
  if (!provider.capacity) return undefined;
  const { endpoint, ...observation } = deploymentCapacitySchema.parse(provider.capacity);
  const base = deriveFoundryInferenceBase(endpoint, provider.type);
  return { ...observation, endpointFingerprint: createHash("sha256").update(base).digest("hex") };
}

export function assertCapacityPolicy(config: {
  contract: Pick<BenchmarkConfig["contract"], "candidate" | "foundryProvider">;
  requestBounds?: BenchmarkConfig["requestBounds"];
}, endpoint?: string): void {
  const provider = config.contract.foundryProvider, capacity = provider.capacity;
  if (!capacity) return;
  deploymentCapacitySchema.parse(capacity);
  const recordedBase = deriveFoundryInferenceBase(capacity.endpoint, provider.type);
  const wire = provider.type === "anthropic" ? "messages" : provider.wireApi ?? "completions";
  if (capacity.deployment !== config.contract.candidate.model || capacity.wireApi !== wire
      || endpoint && recordedBase !== deriveFoundryInferenceBase(endpoint, provider.type)) {
    throw new TypeError("Deployment capacity observation does not match the selected endpoint/deployment/wire API. Bind a new observation to the intended configuration; no inference dispatched.");
  }
  const bounds = config.requestBounds;
  if (!bounds) throw new TypeError("A capacity-bound configuration requires finite requestBounds.");
  if (bounds.requestsPerMinute > capacity.requestsPerMinute || bounds.tokensPerMinute > capacity.tokensPerMinute) {
    throw new TypeError(`Local pacing ${bounds.requestsPerMinute} RPM / ${bounds.tokensPerMinute} TPM exceeds the bound deployment observation ${capacity.requestsPerMinute} RPM / ${capacity.tokensPerMinute} TPM. Choose an approved share before preparing; no inference dispatched.`);
  }
}
