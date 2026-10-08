import { AzureCliCredential, ManagedIdentityCredential, WorkloadIdentityCredential } from "@azure/identity";
import { z } from "zod";
import type { ProviderConfig } from "@github/copilot-sdk";
import type { FoundryAuth, FoundryProviderConfig } from "./types.js";

export const foundryScope = "https://ai.azure.com/.default";
export const authSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("key") }).strict(),
  z.object({
    mode: z.literal("entra"),
    credential: z.enum(["azure-cli", "managed-identity", "workload-identity"]),
    tenantId: z.string().uuid().optional(),
    clientId: z.string().uuid().optional(),
    timeoutMs: z.number().int().min(1000).max(120000).optional(),
  }).strict(),
]);
export const providerSchema = z.object({
  type: z.enum(["openai", "anthropic"]),
  wireApi: z.enum(["completions", "responses"]).optional(),
  auth: authSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.type === "anthropic" && value.wireApi) {
    ctx.addIssue({ code: "custom", message: "wireApi applies only to openai; anthropic uses Messages." });
  }
  if (value.auth?.mode === "entra" && value.auth.credential === "workload-identity"
      && (!value.auth.tenantId || !value.auth.clientId)) {
    ctx.addIssue({ code: "custom", message: "workload-identity requires explicit tenantId and clientId." });
  }
  if (value.auth?.mode === "entra" && value.auth.credential === "azure-cli" && value.auth.clientId) {
    ctx.addIssue({ code: "custom", message: "Azure CLI uses the explicitly signed-in CLI account; clientId selection applies to managed/workload identity." });
  }
  if (value.auth?.mode === "entra" && value.auth.credential === "managed-identity" && value.auth.tenantId) {
    ctx.addIssue({ code: "custom", message: "Managed identity tenant is owned by its Azure host. tenantId selection applies to Azure CLI/workload identity." });
  }
});

export interface RefreshableCredential {
  getToken(scope: string, options: { abortSignal: AbortSignal }): Promise<{ token: string; expiresOnTimestamp: number } | null>;
}

export function createCredential(auth: Extract<FoundryAuth, { mode: "entra" }>): RefreshableCredential {
  switch (auth.credential) {
    case "azure-cli":
      return new AzureCliCredential({ tenantId: auth.tenantId, processTimeoutInMs: auth.timeoutMs ?? 30000 });
    case "managed-identity":
      return auth.clientId ? new ManagedIdentityCredential({ clientId: auth.clientId }) : new ManagedIdentityCredential();
    case "workload-identity":
      return new WorkloadIdentityCredential({ tenantId: auth.tenantId, clientId: auth.clientId });
  }
}

export function bearerTokenProvider(
  auth: Extract<FoundryAuth, { mode: "entra" }>,
  credential: RefreshableCredential = createCredential(auth),
): () => Promise<string> {
  // Coalesce concurrent acquisition, not tokens: Azure Identity owns token caching and renewal.
  let acquiring: Promise<string> | null = null;
  return () => {
    acquiring ??= (async () => {
      const signal = AbortSignal.timeout(auth.timeoutMs ?? 30000);
      let onAbort: (() => void) | undefined;
      try {
        const token = await Promise.race([
          credential.getToken(foundryScope, { abortSignal: signal }),
          new Promise<never>((_, reject) => {
            onAbort = () => reject(new Error("Credential acquisition deadline exceeded."));
            signal.addEventListener("abort", onAbort, { once: true });
          }),
        ]);
        if (!token?.token || token.expiresOnTimestamp <= Date.now()) throw new Error("No valid access token returned.");
        return token.token;
      } catch {
        throw new Error(`Entra ${auth.credential} acquisition failed. Check the selected identity, tenant, login/federation and network. No key or identity fallback was attempted.`);
      } finally {
        if (onAbort) signal.removeEventListener("abort", onAbort);
        acquiring = null;
      }
    })();
    return acquiring;
  };
}

export function providerAuthentication(
  config: FoundryProviderConfig, environment: NodeJS.ProcessEnv, requiredKey: () => string,
): Pick<ProviderConfig, "apiKey" | "bearerTokenProvider"> {
  providerSchema.parse(config);
  if (!config.auth || config.auth.mode === "key") return { apiKey: requiredKey() };
  return { bearerTokenProvider: bearerTokenProvider(config.auth) };
}

export function parseAuthFlags(value: (flag: string) => string | undefined): FoundryAuth | undefined {
  const mode = value("--auth");
  if (!mode) {
    if (value("--credential") || value("--tenant-id") || value("--client-id")) throw new TypeError("Identity options require --auth entra.");
    return undefined;
  }
  if (mode === "key") {
    if (value("--credential") || value("--tenant-id") || value("--client-id")) throw new TypeError("Key mode cannot select an Entra identity.");
    return authSchema.parse({ mode });
  }
  return authSchema.parse({
    mode, credential: value("--credential"), tenantId: value("--tenant-id"), clientId: value("--client-id"),
  });
}

export function inferenceDiagnostic(status: number | null): string {
  switch (status) {
    case 401: return "Authentication rejected: check tenant, token audience or key-disabled policy; do not switch identities automatically.";
    case 403: return "Inference denied: verify endpoint-specific resource RBAC and private-network access. Login or management Contributor is insufficient.";
    case 404: return "Check the resource root, deployment name and selected wire API.";
    case 429: return "Rate/quota admission rejected: inspect retry headers and deployment capacity; permanent quota is not transient.";
    default: return "Check provider/network diagnostics. Ambiguous dispatched requests must not be replayed.";
  }
}
