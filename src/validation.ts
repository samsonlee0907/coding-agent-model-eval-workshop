import { spawn } from "node:child_process";
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
