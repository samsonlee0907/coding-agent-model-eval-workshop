import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  divergesFromValidation,
  loadConformanceProbe,
  runConformanceProbe,
  summarizeConformance,
} from "../src/conformance.js";
import type {
  BenchmarkRun,
  ConformanceCheckSpec,
  ConformanceProbeResult,
} from "../src/types.js";

const timeout = 30_000;

/** A command that exits with the given code, portable across shells. */
function exits(code: number): string {
  return `node -e "process.exit(${code})"`;
}

function check(id: string, command: string, severity?: "required" | "advisory"): ConformanceCheckSpec {
  return {
    id,
    description: `check ${id}`,
    command,
    ...(severity === undefined ? {} : { severity }),
  };
}

function statuses(probe: ConformanceProbeResult): Record<string, string> {
  return Object.fromEntries(probe.checks.map((result) => [result.id, result.status]));
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "conformance-"));
}

test("maps exit codes to pass, fail, and weak according to severity", async () => {
  const root = scratch();
  try {
    const probe = await runConformanceProbe(
      {
        checks: [
          check("ok", exits(0)),
          check("broken", exits(1)),
          check("nitpick", exits(1), "advisory"),
          check("advisory-ok", exits(0), "advisory"),
        ],
      },
      root,
      timeout,
    );
    assert.equal(probe.available, true);
    assert.deepEqual(statuses(probe), {
      ok: "pass",
      broken: "fail",
      nitpick: "weak",
      "advisory-ok": "pass",
    });
    assert.deepEqual(probe.totals, { total: 4, passed: 2, weak: 1, failed: 1, errored: 0 });
    // One required failure is enough to withhold the conformance verdict.
    assert.equal(probe.conformant, false);
    assert.equal(summarizeConformance(probe), "Non-conformant");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an advisory failure records a weakness without making the artifact non-conformant", async () => {
  const root = scratch();
  try {
    const probe = await runConformanceProbe(
      { checks: [check("ok", exits(0)), check("nitpick", exits(1), "advisory")] },
      root,
      timeout,
    );
    assert.equal(probe.conformant, true);
    assert.equal(probe.totals.weak, 1);
    assert.equal(probe.totals.failed, 0);
    assert.equal(summarizeConformance(probe), "Conformant");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("defaults an unspecified severity to required", async () => {
  const root = scratch();
  try {
    const probe = await runConformanceProbe({ checks: [check("broken", exits(1))] }, root, timeout);
    assert.equal(probe.checks[0]?.severity, "required");
    assert.equal(probe.checks[0]?.status, "fail");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed setup command errors every check instead of blaming the artifact", async () => {
  const root = scratch();
  try {
    const probe = await runConformanceProbe(
      {
        setupCommand: exits(3),
        checks: [check("ok", exits(0)), check("broken", exits(1))],
      },
      root,
      timeout,
    );
    assert.equal(probe.available, true);
    assert.equal(probe.setup?.exitCode, 3);
    // The passing check is not credited and the failing one is not held against
    // the candidate: neither result would have been trustworthy.
    assert.deepEqual(statuses(probe), { ok: "error", broken: "error" });
    assert.equal(probe.totals.errored, 2);
    assert.equal(probe.totals.passed, 0);
    assert.equal(probe.conformant, null);
    assert.match(probe.reason ?? "", /setup command failed/i);
    assert.equal(summarizeConformance(probe), "Probe unavailable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a successful setup command runs the checks normally", async () => {
  const root = scratch();
  try {
    const probe = await runConformanceProbe(
      { setupCommand: exits(0), checks: [check("ok", exits(0))] },
      root,
      timeout,
    );
    assert.equal(probe.setup?.exitCode, 0);
    assert.equal(probe.conformant, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a probe with no checks reports itself unavailable rather than trivially conformant", async () => {
  const root = scratch();
  try {
    const probe = await runConformanceProbe({ checks: [] }, root, timeout);
    assert.equal(probe.available, false);
    assert.equal(probe.conformant, null);
    assert.equal(probe.totals.total, 0);
    assert.match(probe.reason ?? "", /no checks/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a probe of only advisory checks cannot produce a conformance verdict", async () => {
  const root = scratch();
  try {
    const probe = await runConformanceProbe(
      { checks: [check("nitpick", exits(0), "advisory")] },
      root,
      timeout,
    );
    assert.equal(probe.checks[0]?.status, "pass");
    // Nothing required was asserted, so there is no claim to make.
    assert.equal(probe.conformant, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a required check that times out leaves the verdict inconclusive", async () => {
  const root = scratch();
  try {
    const probe = await runConformanceProbe(
      { checks: [check("ok", exits(0)), check("hangs", 'node -e "setTimeout(() => {}, 10000)"')] },
      root,
      50,
    );
    const hangs = probe.checks.find((result) => result.id === "hangs");
    assert.equal(hangs?.timedOut, true);
    assert.equal(hangs?.status, "error");
    // A check that never finished is absence of evidence, not evidence of a defect.
    assert.equal(probe.conformant, null);
    assert.equal(probe.totals.failed, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("records the command, duration, and captured output for each check", async () => {
  const root = scratch();
  try {
    const command = 'node -e "console.log(\'probe says hello\'); process.exit(0)"';
    const probe = await runConformanceProbe({ checks: [check("ok", command)] }, root, timeout);
    const result = probe.checks[0];
    assert.equal(result?.command, command);
    assert.match(result?.stdout ?? "", /probe says hello/);
    assert.ok((result?.durationMs ?? -1) >= 0);
    assert.ok(Date.parse(probe.startedAt) <= Date.parse(probe.completedAt));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function run(overrides: Partial<BenchmarkRun>): BenchmarkRun {
  return {
    outcome: { class: "resolved", reason: "validation passed" },
    artifacts: {},
    ...overrides,
  } as unknown as BenchmarkRun;
}

const conformantProbe = {
  available: true,
  description: null,
  startedAt: "2026-01-01T00:00:00.000Z",
  completedAt: "2026-01-01T00:00:01.000Z",
  durationMs: 1000,
  setup: null,
  checks: [],
  totals: { total: 1, passed: 1, weak: 0, failed: 0, errored: 0 },
  conformant: true,
} as unknown as ConformanceProbeResult;

const failingProbe = { ...conformantProbe, conformant: false } as ConformanceProbeResult;

test("loads a probe embedded in the run in preference to any sidecar", () => {
  assert.equal(loadConformanceProbe(run({ conformance: conformantProbe })), conformantProbe);
});

test("loads a probe from the artifact sidecar when the run predates the embedded field", () => {
  const root = scratch();
  try {
    const path = join(root, "conformance-probe.json");
    writeFileSync(path, JSON.stringify(conformantProbe), "utf8");
    const loaded = loadConformanceProbe(run({ artifacts: { directory: root } as never }));
    assert.equal(loaded?.conformant, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports a run recorded before probes existed as not probed instead of failing", () => {
  const root = scratch();
  try {
    const loaded = loadConformanceProbe(run({ artifacts: { directory: root } as never }));
    assert.equal(loaded, null);
    assert.equal(summarizeConformance(loaded), "Not probed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("treats an unreadable sidecar as not probed rather than throwing", () => {
  const root = scratch();
  try {
    writeFileSync(join(root, "conformance-probe.json"), "{ not json", "utf8");
    assert.equal(loadConformanceProbe(run({ artifacts: { directory: root } as never })), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("flags a green run that failed a required expectation as divergent", () => {
  assert.equal(divergesFromValidation(run({}), failingProbe), true);
});

test("does not flag divergence when the probe agrees, is inconclusive, or is absent", () => {
  assert.equal(divergesFromValidation(run({}), conformantProbe), false);
  assert.equal(divergesFromValidation(run({}), { ...conformantProbe, conformant: null }), false);
  assert.equal(divergesFromValidation(run({}), null), false);
});

test("does not flag divergence for a run the validation command already failed", () => {
  const unresolved = run({ outcome: { class: "unresolved", reason: "tests failed" } as never });
  assert.equal(divergesFromValidation(unresolved, failingProbe), false);
});
