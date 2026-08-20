import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative } from "node:path";
import test from "node:test";
import {
  createIsolatedCopilotRuntimeDirectory,
  resolveCopilotCliPath,
  resolveMcpServersForLaunch,
  resolveSdkToolAllowlist,
} from "../src/runner.js";

test("maps benchmark tool capabilities to source-qualified SDK built-ins", () => {
  const expectedShell = process.platform === "win32" ? "powershell" : "bash";
  assert.deepEqual(resolveSdkToolAllowlist(["read", "edit", "shell"]), [
    "builtin:view",
    "builtin:glob",
    "builtin:edit",
    `builtin:${expectedShell}`,
  ]);
});

test("leaves the allowlist unchanged when no MCP servers are configured", () => {
  const expectedShell = process.platform === "win32" ? "powershell" : "bash";
  const expected = ["builtin:view", "builtin:glob", "builtin:edit", `builtin:${expectedShell}`];
  assert.deepEqual(resolveSdkToolAllowlist(["read", "edit", "shell"], undefined), expected);
  assert.deepEqual(resolveSdkToolAllowlist(["read", "edit", "shell"], {}), expected);
});

test("exposes MCP tools in the allowlist only when servers are configured", () => {
  const allowlist = resolveSdkToolAllowlist(["read", "edit", "shell"], {
    fetch: { command: "npx", args: ["-y", "mcp-server-fetch"] },
  });
  assert.equal(allowlist.includes("mcp:*"), true);
  assert.equal(allowlist.includes("builtin:view"), true);
});

test("returns undefined MCP launch config when none are configured", () => {
  assert.equal(resolveMcpServersForLaunch(undefined, {}), undefined);
  assert.equal(resolveMcpServersForLaunch({}, {}), undefined);
});

test("expands ${ENV_VAR} placeholders in MCP specs at launch", () => {
  const resolved = resolveMcpServersForLaunch(
    {
      search: {
        type: "http",
        url: "https://mcp.example/${SEARCH_HOST_PATH}",
        headers: { Authorization: "Bearer ${SEARCH_TOKEN}" },
      },
    },
    { SEARCH_HOST_PATH: "v1/search", SEARCH_TOKEN: "secret-value" },
  );
  const server = resolved?.search as { url: string; headers: Record<string, string> };
  assert.equal(server.url, "https://mcp.example/v1/search");
  assert.equal(server.headers.Authorization, "Bearer secret-value");
});

test("fails fast when an MCP placeholder references an unset variable", () => {
  assert.throws(
    () =>
      resolveMcpServersForLaunch(
        { search: { type: "http", url: "https://mcp.example", headers: { Authorization: "Bearer ${MISSING_TOKEN}" } } },
        {},
      ),
    /MISSING_TOKEN/,
  );
});

test("creates isolated Copilot state in a short temporary path", () => {
  const runtimeDirectory = createIsolatedCopilotRuntimeDirectory();
  try {
    assert.equal(existsSync(runtimeDirectory), true);
    assert.equal(isAbsolute(runtimeDirectory), true);
    assert.equal(relative(tmpdir(), runtimeDirectory).startsWith(".."), false);
  } finally {
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

test("prefers an explicit or discovered external Copilot CLI runtime", () => {
  assert.equal(
    resolveCopilotCliPath(
      { BENCHMARK_COPILOT_CLI_PATH: "C:\\tools\\copilot.exe" },
      "win32",
      () => "ignored",
    ),
    "C:\\tools\\copilot.exe",
  );
  assert.equal(
    resolveCopilotCliPath({}, "win32", (command) => {
      assert.equal(command, "copilot.exe");
      return "C:\\installed\\copilot.exe";
    }),
    "C:\\installed\\copilot.exe",
  );
  assert.equal(resolveCopilotCliPath({}, "linux", () => null), undefined);
});
