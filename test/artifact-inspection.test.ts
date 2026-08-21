import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectArtifact, renderSourceBundle, satisfiesRange } from "../src/artifact-inspection.js";

function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "inspect-"));
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, ...path.split("/"));
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, content, "utf8");
  }
  return root;
}

test("classifies hand-authored files and excludes build output from the review set", () => {
  const root = workspace({
    "package.json": JSON.stringify({ name: "demo", version: "1.0.0" }),
    "src/store.ts": "export class Store {}\nexport const limit = 1;\n",
    "src/store.test.ts": "test('works', () => {});\n",
    "dist/store.js": "class Store {}\n",
    "dist/store.test.js": "test('works', () => {});\n",
    "README.md": "# demo\n",
    "node_modules/left-pad/index.js": "module.exports = 1;\n",
  });
  try {
    const inspection = inspectArtifact(root);
    assert.equal(inspection.available, true);
    assert.equal(inspection.totals.sourceFiles, 1);
    assert.equal(inspection.totals.testFiles, 1);
    assert.equal(inspection.totals.sourceLines, 2);
    // node_modules is never walked, so it cannot appear anywhere in the inventory.
    assert.equal(inspection.files.some((file) => file.path.includes("node_modules")), false);
    // dist/ is inventoried but never offered for review.
    assert.equal(inspection.totals.buildOutputFiles, 2);
    assert.equal(inspection.sources.some((file) => file.path.startsWith("dist/")), false);
    assert.deepEqual(inspection.exports, [
      { file: "src/store.ts", kind: "class", symbol: "Store" },
      { file: "src/store.ts", kind: "const", symbol: "limit" },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("flags test files collected from build output, which inflate a reported test count", () => {
  const root = workspace({
    "src/store.test.ts": "test('a', () => {});\n",
    "dist/store.test.js": "test('a', () => {});\n",
  });
  try {
    assert.deepEqual(inspectArtifact(root).testFilesUnderBuildOutput, ["dist/store.test.js"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("flags a manifest entry point the delivered artifact does not contain", () => {
  const root = workspace({
    "package.json": JSON.stringify({ name: "demo", main: "dist/store.js", types: "dist/store.d.ts" }),
    "dist/src/store.js": "export class Store {}\n",
    "dist/src/store.d.ts": "export declare class Store {}\n",
  });
  try {
    const { entryPoints } = inspectArtifact(root);
    assert.deepEqual(entryPoints.map((entry) => [entry.field, entry.exists]), [["main", false], ["types", false]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detects an installed dependency the manifest's declared range does not allow", () => {
  const root = workspace({
    "package.json": JSON.stringify({
      name: "demo",
      dependencies: { keep: "^1.2.0" },
      devDependencies: { vitest: "^3.0.0", missing: "^2.0.0" },
    }),
    "node_modules/keep/package.json": JSON.stringify({ name: "keep", version: "1.4.0" }),
    "node_modules/vitest/package.json": JSON.stringify({ name: "vitest", version: "5.0.0-rc.1" }),
  });
  try {
    const drift = new Map(inspectArtifact(root).dependencyDrift.map((entry) => [entry.name, entry]));
    assert.equal(drift.get("keep")?.satisfied, true);
    assert.equal(drift.get("vitest")?.satisfied, false);
    assert.equal(drift.get("vitest")?.installedIsPrerelease, true);
    assert.equal(drift.get("missing")?.installed, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("range satisfaction follows npm semantics, including the prerelease rule", () => {
  assert.equal(satisfiesRange("5.7.3", "^5.7.0"), true);
  assert.equal(satisfiesRange("7.0.2", "^5.7.0"), false);
  assert.equal(satisfiesRange("0.3.1", "^0.2.0"), false);
  assert.equal(satisfiesRange("1.2.9", "~1.2.0"), true);
  assert.equal(satisfiesRange("1.3.0", "~1.2.0"), false);
  // A prerelease never satisfies a range that does not name that same core release.
  assert.equal(satisfiesRange("3.1.0-beta.1", "^3.0.0"), false);
  assert.equal(satisfiesRange("2.0.0", ">=1.0.0"), true);
  // Unevaluated range forms are reported as unknown rather than guessed.
  assert.equal(satisfiesRange("1.0.0", "1.x || 2.x"), null);
  assert.equal(satisfiesRange("1.0.0", "workspace:*"), null);
});

test("reports an unavailable inspection instead of inventing code when the workspace is gone", () => {
  const inspection = inspectArtifact(join(tmpdir(), "definitely-not-a-real-workspace-9f3a"));
  assert.equal(inspection.available, false);
  assert.match(inspection.reason ?? "", /no longer exists/);
  assert.deepEqual(inspection.sources, []);
  assert.match(renderSourceBundle(inspection, 1_000), /^unavailable - /);
});

test("source bundle numbers every line so findings can be anchored to a citation", () => {
  const root = workspace({ "src/a.ts": "const a = 1;\nconst b = 2;\n" });
  try {
    const bundle = renderSourceBundle(inspectArtifact(root), 10_000);
    assert.match(bundle, /--- src\/a\.ts \(source, 2 lines\) ---/);
    assert.match(bundle, /1\| const a = 1;/);
    assert.match(bundle, /2\| const b = 2;/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("source bundle keeps at least one file and names what the budget dropped", () => {
  const root = workspace({
    "src/a.ts": "x".repeat(400),
    "src/b.ts": "y".repeat(400),
  });
  try {
    const bundle = renderSourceBundle(inspectArtifact(root), 200);
    assert.match(bundle, /src\/a\.ts \(source/);
    assert.match(bundle, /omitted for budget \(1 file\(s\)\)/);
    assert.match(bundle, /src\/b\.ts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
