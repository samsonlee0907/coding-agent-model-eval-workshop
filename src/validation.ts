import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ValidationResult } from "./types.js";

const maxCapturedOutputBytes = 64 * 1024;

export async function runValidation(command: string, cwd: string, timeoutMs: number): Promise<ValidationResult> {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  return new Promise((resolve) => {
    const stdout = new OutputCapture();
    const stderr = new OutputCapture();
    const failures: NonNullable<ValidationResult["failures"]> = [];
    let errorMessage: string | null = null;
    let settled = false;
    let timedOut = false;
    let terminating = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const recordFailure = (phase: NonNullable<ValidationResult["failures"]>[number]["phase"], error: unknown) => {
      const code = errorCode(error);
      if (!failures.some((failure) => failure.phase === phase)) failures.push({ phase, code });
      const detail = `Validator ${phase} failed${code ? ` (${code})` : ""}`;
      const guidance = phase === "spawn" ? "; check working-directory length/existence and shell/executable availability."
        : phase === "cleanup" ? "; owned process-tree cleanup could not be certified."
        : "; child output/execution cannot be certified.";
      if (!errorMessage) errorMessage = detail + guidance;
      else if (phase === "spawn" || phase === "cleanup") errorMessage += ` ${detail}${guidance}`;
    };
    const finish = (exitCode: number | null): void => {
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
        ...(failures.length ? { failures: [...failures] } : {}),
      });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, {
        cwd, shell: true, stdio: ["ignore", "pipe", "pipe"],
        env: scrubFoundryEnvironment(process.env),
        detached: process.platform !== "win32", windowsHide: true,
      });
    } catch (error) {
      recordFailure("spawn", error); finish(null); return;
    }
    const destroyStreams = () => {
      child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
    };
    const terminate = () => {
      if (terminating || settled) return;
      terminating = true;
      clearTimeout(timer);
      const terminated = (error: Error | null = null) => {
        if (error) recordFailure("cleanup", error);
        destroyStreams(); finish(null);
      };
      if (!child.pid) terminated();
      else if (child.exitCode !== null || child.signalCode !== null) {
        terminated(new Error("The parent already exited; escaped background descendants cannot be safely identified in trusted-local mode."));
      } else if (process.platform === "win32") {
        execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { timeout: 5000, windowsHide: true }, (error) => terminated(error));
      } else {
        try { process.kill(-child.pid, "SIGKILL"); terminated(); }
        catch (error) { terminated(error instanceof Error ? error : new Error(String(error))); }
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => stdout.append(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.append(chunk));
    for (const [phase, stream] of [["stdin", child.stdin], ["stdout", child.stdout], ["stderr", child.stderr]] as const) {
      // Failed Windows spawns can emit pipe errors as well as the child 'error'.
      stream?.on("error", (error) => {
        if (settled || terminating) return;
        recordFailure(phase, error);
        if (child.pid) terminate();
      });
    }
    timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    child.once("error", (error) => {
      if (settled) return;
      recordFailure(child.pid ? "process" : "spawn", error);
      if (child.pid) terminate();
      else { destroyStreams(); finish(null); }
    });
    child.once("close", (code) => { if (!terminating) finish(failures.length ? null : code); });
  });
}

function errorCode(error: unknown): string | null {
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  return typeof code === "string" && code.length <= 64 && /^(?:E[A-Z0-9_]+|ERR_[A-Z0-9_]+)$/.test(code) ? code : null;
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
