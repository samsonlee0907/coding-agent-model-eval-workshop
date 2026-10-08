#!/usr/bin/env node
import { doctor } from "./doctor.js";
import { resolve } from "node:path";
import { assertCliArguments } from "./cli-arguments.js";

try {
  if (process.argv.includes("--help")) {
    console.log("Usage: npm run doctor -- --config <benchmark.json> [--acquire-auth]\nDefault: local checks only; never sends inference.");
  } else {
    assertCliArguments(process.argv.slice(2), { "--config": "value", "--acquire-auth": "switch" });
    const index = process.argv.indexOf("--config");
    const path = index < 0 ? undefined : process.argv[index + 1];
    if (!path || path.startsWith("--")) throw new TypeError("--config requires a benchmark configuration path.");
    const result = await doctor(resolve(path), process.argv.includes("--acquire-auth"));
    console.log(JSON.stringify(result, null, 2));
    if (!result.localChecksPassed) process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2;
}
