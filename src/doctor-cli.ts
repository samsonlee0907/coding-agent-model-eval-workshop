#!/usr/bin/env node
import { doctor } from "./doctor.js";
import { resolve } from "node:path";
import { assertCliArguments } from "./cli-arguments.js";

try {
  if (process.argv.includes("--help")) {
    console.log("Usage: npm run doctor -- --config <benchmark.json> [--acquire-auth] [--verify-runtime] [--allow-container-probe]\n" +
      "Default: local checks only; never sends inference.\n--verify-runtime creates/edits disposable public fixtures via actual SDK/CLI and local fake Responses.\n" +
      "Container configs additionally require --allow-container-probe (creates owned Docker resources). --acquire-auth is separately token-only.");
  } else {
    assertCliArguments(process.argv.slice(2), { "--config": "value", "--acquire-auth": "switch", "--verify-runtime": "switch", "--allow-container-probe": "switch" });
    if (process.argv.includes("--allow-container-probe") && !process.argv.includes("--verify-runtime")) throw new TypeError("--allow-container-probe requires --verify-runtime.");
    const index = process.argv.indexOf("--config");
    const path = index < 0 ? undefined : process.argv[index + 1];
    if (!path || path.startsWith("--")) throw new TypeError("--config requires a benchmark configuration path.");
    const result = await doctor(resolve(path), process.argv.includes("--acquire-auth"), process.argv.includes("--verify-runtime"), process.argv.includes("--allow-container-probe"));
    console.log(JSON.stringify(result, null, 2));
    if (!result.localChecksPassed) process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2;
}
