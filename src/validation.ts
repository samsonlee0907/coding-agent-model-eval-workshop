import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ValidationResult } from "./types.js";

const maxCapturedOutputBytes = 64 * 1024;

export async function runValidation(command: string, cwd: string, timeoutMs: number): Promise<ValidationResult> {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: scrubFoundryEnvironment(process.env),
    });
    const stdout = new OutputCapture();
    const stderr = new OutputCapture();
    let settled = false;
    let timedOut = false;
    const finish = (exitCode: number | null, errorMessage: string | null): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      resolve({
        command,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
        exitCode,
        timedOut,
        errorMessage,
        stdout: stdout.value(),
        stderr: stderr.value(),
      });
    };
    child.stdout?.on("data", (chunk: Buffer) => stdout.append(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.append(chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.once("error", (error) => finish(null, error.message));
    child.once("close", (code) => finish(code, null));
  });
}

/**
 * Candidate code and validators never need the benchmark's Foundry
 * configuration. Remove it before spawning an agent-controlled process.
 */
export function scrubFoundryEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized = { ...environment };
  delete sanitized.FOUNDRY_API_KEY;
  delete sanitized.FOUNDRY_ENDPOINT;
  return sanitized;
}

class OutputCapture {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  private truncated = false;

  public append(chunk: Buffer): void {
    const remaining = maxCapturedOutputBytes - this.size;
    if (remaining <= 0) {
      this.truncated = true;
      return;
    }
    const retained = chunk.subarray(0, remaining);
    this.chunks.push(retained);
    this.size += retained.length;
    this.truncated ||= retained.length !== chunk.length;
  }

  public value(): string {
    const output = Buffer.concat(this.chunks).toString("utf8");
    return this.truncated ? `${output}\n[output truncated at ${maxCapturedOutputBytes} bytes]` : output;
  }
}

/**
 * Auto-validation is intentionally conservative: it runs only project scripts
 * that are present after the agent's work, otherwise it records a deterministic
 * failure instead of treating a missing build/test script as success.
 */
export function resolveValidationCommand(command: string, cwd: string): string {
  if (command !== "auto") {
    return command;
  }
  const packageJsonPath = join(cwd, "package.json");
  if (!existsSync(packageJsonPath)) {
    return missingValidationCommand("No package.json was created; unable to validate the generated application.");
  }
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    packageManager?: unknown;
    scripts?: Record<string, unknown>;
  };
  const scripts = packageJson.scripts ?? {};
  const packageRunner = selectPackageRunner(cwd, packageJson.packageManager);
  const commands: string[] = [];
  if (typeof scripts.test === "string") {
    commands.push(packageRunner.test);
  }
  if (typeof scripts.build === "string") {
    commands.push(packageRunner.build);
  }
  return commands.length > 0
    ? commands.join(" && ")
    : missingValidationCommand("package.json has neither a test nor build script.");
}

function selectPackageRunner(cwd: string, packageManager: unknown): { test: string; build: string } {
  if ((typeof packageManager === "string" && packageManager.startsWith("pnpm@")) || existsSync(join(cwd, "pnpm-lock.yaml"))) {
    return { test: "pnpm test", build: "pnpm run build" };
  }
  if ((typeof packageManager === "string" && packageManager.startsWith("yarn@")) || existsSync(join(cwd, "yarn.lock"))) {
    return { test: "yarn test", build: "yarn build" };
  }
  return { test: "npm test", build: "npm run build" };
}

function missingValidationCommand(reason: string): string {
  const encodedReason = Buffer.from(reason, "utf8").toString("base64");
  return `node -e "console.error(Buffer.from('${encodedReason}', 'base64').toString('utf8')); process.exit(2)"`;
}
