import { resolve } from "node:path";
import type { FoundryProviderType, ReasoningEffort } from "./types.js";

export interface EvaluationCliOptions {
  runsDirectory: string;
  provider: FoundryProviderType;
  model: string;
  reasoningEffort: ReasoningEffort;
  timeoutMs: number;
  outputPath?: string;
}

export function parseEvaluationOptions(argv: readonly string[]): EvaluationCliOptions {
  const supported = new Set(["--runs", "--provider", "--model", "--reasoning-effort", "--timeout-ms", "--output"]);
  for (const token of argv) {
    if (token.startsWith("--") && !supported.has(token)) {
      throw new TypeError(`Unsupported option ${token}. See npm run evaluate -- --help.`);
    }
  }
  const provider = requiredProvider(argumentValue(argv, "--provider"));
  const model = required(argumentValue(argv, "--model"), "--model");
  const timeoutText = argumentValue(argv, "--timeout-ms");
  const timeoutMs = timeoutText ? Number(timeoutText) : 120_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 900_000) {
    throw new TypeError("--timeout-ms must be an integer from 1000 through 900000.");
  }
  const output = argumentValue(argv, "--output");
  return {
    runsDirectory: resolve(argumentValue(argv, "--runs") ?? ".benchmark-runs"),
    provider,
    model,
    reasoningEffort: reasoningEffort(argumentValue(argv, "--reasoning-effort")),
    timeoutMs,
    outputPath: output ? resolve(output) : undefined,
  };
}

function argumentValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) {
    return undefined;
  }
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new TypeError(`${flag} requires a value.`);
  }
  return value;
}

function required(value: string | undefined, flag: string): string {
  if (!value) {
    throw new TypeError(`${flag} is required.`);
  }
  return value;
}

function requiredProvider(value: string | undefined): FoundryProviderType {
  if (value === "openai" || value === "anthropic") {
    return value;
  }
  throw new TypeError("--provider is required and must be exactly openai or anthropic.");
}

function reasoningEffort(value: string | undefined): ReasoningEffort {
  if (!value) {
    return "high";
  }
  if (value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max") {
    return value;
  }
  throw new TypeError("--reasoning-effort must be low, medium, high, xhigh, or max.");
}
