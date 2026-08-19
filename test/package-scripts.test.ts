import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

interface PackageManifest {
  scripts?: Record<string, string>;
}

test("runnable commands rebuild the distributable first", () => {
  const manifest = JSON.parse(
    readFileSync(resolve(process.cwd(), "package.json"), "utf8"),
  ) as PackageManifest;

  for (const command of ["bench", "quickstart", "portfolio", "evaluate"]) {
    assert.equal(manifest.scripts?.[`pre${command}`], "npm run build");
  }
});
