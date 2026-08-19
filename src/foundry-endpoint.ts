import type { FoundryProviderType } from "./types.js";

const servicesHostSuffix = ".services.ai.azure.com";
const openAiHostSuffix = ".openai.azure.com";

/**
 * Converts the canonical Foundry resource root into the documented
 * model-inference base required by the selected Copilot SDK provider protocol.
 */
export function deriveFoundryInferenceBase(
  configuredUrl: string,
  providerType: FoundryProviderType,
): string {
  const endpoint = parseFoundryEndpoint(configuredUrl);
  const resourceName = resourceNameFromHost(endpoint.hostname);
  assertCanonicalResourceRoot(endpoint.pathname);
  return providerType === "openai"
    ? `https://${resourceName}${openAiHostSuffix}/openai/v1`
    : `https://${resourceName}${servicesHostSuffix}/anthropic`;
}

function parseFoundryEndpoint(configuredUrl: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(configuredUrl);
  } catch {
    throw new TypeError("Foundry resource URL must be a valid https URL.");
  }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new TypeError("Foundry resource URL must be an https URL without credentials, query parameters, or a fragment.");
  }
  return endpoint;
}

function resourceNameFromHost(hostname: string): string {
  const normalizedHost = hostname.toLowerCase();
  if (!normalizedHost.endsWith(servicesHostSuffix)) {
    throw new TypeError(
      "FOUNDRY_ENDPOINT must use the canonical https://<resource>.services.ai.azure.com resource root.",
    );
  }
  const suffix = servicesHostSuffix;
  const resourceName = normalizedHost.slice(0, -suffix.length);
  if (!resourceName || resourceName.includes(".")) {
    throw new TypeError("Foundry resource URL must identify exactly one resource hostname.");
  }
  return resourceName;
}

function assertCanonicalResourceRoot(pathname: string): void {
  if (pathname !== "/" && pathname !== "") {
    throw new TypeError(
      "FOUNDRY_ENDPOINT must be the resource root without a project, /anthropic, or /openai/v1 path.",
    );
  }
}
