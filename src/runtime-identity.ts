import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolveCopilotCliPath } from "./runner.js";
import type { RuntimeIdentity } from "./types.js";

const require = createRequire(import.meta.url);
export function installedSdkVersion(): string {
  let directory = dirname(require.resolve("@github/copilot-sdk"));
  for (;;) {
    const path = join(directory, "package.json");
    if (existsSync(path)) {
      const metadata: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (metadata && typeof metadata === "object" && "name" in metadata && metadata.name === "@github/copilot-sdk") {
        if (!("version" in metadata) || typeof metadata.version !== "string" || !metadata.version) throw new Error("The installed SDK package has no valid version.");
        return metadata.version;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error("Cannot locate the installed SDK package metadata.");
    directory = parent;
  }
}
export function readRuntimeIdentity(): RuntimeIdentity {
  const external = resolveCopilotCliPath(process.env);
  const path = external ?? require.resolve(`@github/copilot-${process.platform}-${process.arch}`);
  const version = execFileSync(path, ["--version"], { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] });
  const cliVersion = /\b(\d+\.\d+\.\d+(?:[-.][a-zA-Z0-9.-]+)?)\b/.exec(version)?.[1];
  if (!cliVersion) throw new Error("Cannot identify the selected CLI runtime; configure BENCHMARK_COPILOT_CLI_PATH explicitly.");
  return { sdkVersion: installedSdkVersion(), cliVersion, nodeVersion: process.version,
    cliSha256: createHash("sha256").update(readFileSync(path)).digest("hex") };
}
