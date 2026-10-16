import { AzureCliCredential, ManagedIdentityCredential, WorkloadIdentityCredential } from "@azure/identity";
import { z } from "zod";
import type { ProviderConfig } from "@github/copilot-sdk";
import type { FoundryAuth, FoundryProviderConfig } from "./types.js";
import { deploymentCapacitySchema } from "./deployment-capacity.js";
import { nativeTokenCountPolicySchema } from "./native-token-count.js";

export const foundryScope = "https://ai.azure.com/.default";
export const authSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("key") }).strict(),
  z.object({
    mode: z.literal("entra"),
    credential: z.enum(["azure-cli", "managed-identity", "workload-identity"]),
    tenantId: z.string().uuid().optional(),
    subscriptionId: z.string().uuid().optional(),
    clientId: z.string().uuid().optional(),
    timeoutMs: z.number().int().min(1000).max(120000).optional(),
  }).strict(),
]).superRefine((auth, ctx) => {
  if (auth.mode === "entra" && auth.credential === "azure-cli" && auth.tenantId && auth.subscriptionId) {
    ctx.addIssue({ code: "custom", message: "Azure CLI token acquisition accepts only one of tenantId or subscriptionId, not both. Choose the intended selector explicitly; neither is silently ignored." });
  }
});
export const providerSchema = z.object({
  type: z.enum(["openai", "anthropic"]),
  wireApi: z.enum(["completions", "responses"]).optional(),
  auth: authSchema.optional(),
  capacity: deploymentCapacitySchema.optional(),
  nativeTokenCount: nativeTokenCountPolicySchema.optional(),
  anthropicThinking: z.literal("adaptive").optional(),
}).strict().superRefine((value, ctx) => {
  if (value.auth?.mode === "entra" && value.auth.subscriptionId && value.auth.credential !== "azure-cli") {
    ctx.addIssue({ code: "custom", message: "subscriptionId selects an Azure CLI account only; it does not apply to managed/workload identity." });
  }
  if (value.type === "anthropic" && value.wireApi) {
    ctx.addIssue({ code: "custom", message: "wireApi applies only to openai; anthropic uses Messages." });
  }
  if (value.type !== "anthropic" && (value.nativeTokenCount || value.anthropicThinking)) ctx.addIssue({
    code: "custom", message: "nativeTokenCount and anthropicThinking apply only to Anthropic Messages.",
  });
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
  providerSchema.parse({ type: "openai", auth });
  switch (auth.credential) {
    case "azure-cli":
      return new AzureCliCredential({ tenantId: auth.tenantId, subscription: auth.subscriptionId, processTimeoutInMs: auth.timeoutMs ?? 30000 });
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
      } catch (error) {
        throw new Error(`Entra ${auth.credential} acquisition failed. ${credentialFailureDetail(error)} No key or identity fallback was attempted.`);
      } finally {
        if (onAbort) signal.removeEventListener("abort", onAbort);
        acquiring = null;
      }

    })();
    return acquiring;
  };
}

export function credentialFailureDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/Please specify only one of subscription and tenant, not both/i.test(message)) {
    return "Azure CLI option conflict: choose only one of tenantId or subscriptionId, not both. No token or inference was acquired.";
  }
  const aad = /\bAADSTS\d{5,10}\b/.exec(message)?.[0];
  if (aad === "AADSTS90072" || aad === "AADSTS50020") return `${aad}: selected account does not belong to the requested tenant. Select the intended CLI tenant/subscription explicitly; this is not inference RBAC or quota.`;
  if (aad) return `${aad}: identity service rejected credential acquisition. Check login, tenant and federation; no inference was sent.`;
  if (/deadline|timed? ?out/i.test(message)) return "Credential acquisition timed out; check identity-service connectivity.";
  if (/\b(?:ENOTFOUND|ECONNREFUSED|ECONNRESET)\b/.test(message)) return "Identity-service network connection failed; check DNS/connectivity.";
  return "Check the selected account, tenant/subscription, login/federation and network.";
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
    if (value("--credential") || value("--tenant-id") || value("--client-id") || value("--subscription-id")) throw new TypeError("Identity options require --auth entra.");
    return undefined;
  }
  if (mode === "key") {
    if (value("--credential") || value("--tenant-id") || value("--client-id") || value("--subscription-id")) throw new TypeError("Key mode cannot select an Entra identity.");
    return authSchema.parse({ mode });
  }
  const credential = value("--credential");
  const tenantId = value("--tenant-id");
  const clientId = value("--client-id");
  const subscriptionId = value("--subscription-id");
  return authSchema.parse({
    mode, credential,
    ...(tenantId ? { tenantId } : {}),
    ...(clientId ? { clientId } : {}),
    ...(subscriptionId ? { subscriptionId } : {}),
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
