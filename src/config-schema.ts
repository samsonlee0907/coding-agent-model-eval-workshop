import { z } from "zod";
import { providerSchema } from "./auth.js";
import { isolationSchema } from "./controlled-worker.js";
import { requestBoundsSchema } from "./request-policy.js";

const mcpCommon = { tools: z.array(z.string()).optional(), timeout: z.number().int().positive().optional() };
const mcpSchema = z.union([
  z.object({ ...mcpCommon, type: z.enum(["stdio", "local"]).optional(), command: z.string().min(1),
    args: z.array(z.string()).optional(), env: z.record(z.string(), z.string()).optional(), workingDirectory: z.string().optional() }).strict(),
  z.object({ ...mcpCommon, type: z.enum(["http", "sse"]), url: z.string().min(1), headers: z.record(z.string(), z.string()).optional() }).strict(),
]);

export const benchmarkConfigSchema = z.object({
  contract: z.object({
    task: z.object({
      id: z.string().min(1), version: z.string().min(1).optional(), title: z.string().min(1).optional(),
      taskType: z.string().min(1).optional(), tags: z.array(z.string()).optional(), inputsHash: z.string().optional(),
      graderInputsHash: z.string().optional(),
      prompt: z.string().min(1), validationCommand: z.string().min(1),
      repository: z.object({ url: z.string().optional(), commitSha: z.string().min(1), containerFingerprint: z.string().min(1) }).strict(),
      conformanceProbe: z.object({
        description: z.string().optional(), setupCommand: z.string().optional(), timeoutMs: z.number().int().positive().optional(),
        checks: z.array(z.object({
          id: z.string().min(1), description: z.string(), command: z.string().min(1),
          severity: z.enum(["required", "advisory"]).optional(),
        }).strict()),
      }).strict().optional(),
    }).strict(),
    candidate: z.object({ provider: z.string().min(1), model: z.string().min(1), deployment: z.string().optional() }).strict(),
    execution: z.object({
      instructions: z.string(), tools: z.array(z.enum(["read", "edit", "shell"])), permissionMode: z.enum(["approve-all", "manual"]),
      concurrency: z.literal(1), retries: z.number().int().min(0).max(10), sessionTimeoutMs: z.number().int().positive(),
      streaming: z.literal(true), cachePolicy: z.literal("default"), reasoningEffort: z.enum(["low", "medium", "high", "xhigh", "max"]),
      mcpServers: z.record(z.string(), mcpSchema).optional(),
    }).strict(),
    runtime: z.object({ sdkVersion: z.string(), cliVersion: z.string(), nodeVersion: z.string(),
      cliSha256: z.string().regex(/^[a-f0-9]{64}$/) }).partial().optional(),
    foundryProvider: providerSchema,
  }).strict(),
  rounds: z.array(z.object({ prompt: z.string(), mode: z.enum(["enqueue", "immediate"]).optional() }).strict()),
  workspacePath: z.string().min(1), artifactsDirectory: z.string().optional(),
  isolation: isolationSchema.optional(), requestBounds: requestBoundsSchema.optional(),
}).strict();
