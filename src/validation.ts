import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ValidationResult } from "./types.js";

export async function runValidation(command: string, cwd: string, timeoutMs: number): Promise<ValidationResult> {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, stdio: "ignore" });
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
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.once("error", (error) => finish(null, error.message));
    child.once("close", (code) => finish(code, null));
  });
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
  return `node -e "console.error(${JSON.stringify(reason)}); process.exit(2)"`;
}
