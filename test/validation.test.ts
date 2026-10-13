import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runValidation } from "../src/validation.js";

test("validation returns explicit bounded errors for invalid CWD and synchronous spawn failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "bt-validator-"));
  try {
    const missing = await runValidation("node --version", join(root, "missing"), 5000);
    assert.equal(missing.exitCode, null); assert.equal(missing.timedOut, false);
    assert.ok(missing.failures?.some((error) => error.phase === "spawn" && error.code === "ENOENT"));
    assert.match(missing.errorMessage!, /spawn failed.*ENOENT/);
    const invalid = await runValidation("node\u0000", root, 5000);
    assert.equal(invalid.exitCode, null);
    assert.deepEqual(invalid.failures, [{ phase: "spawn", code: "ERR_INVALID_ARG_VALUE" }]);
    assert.match(invalid.errorMessage!, /shell\/executable/);
    const bounded = await runValidation('node -e "process.stdout.write(\'x\'.repeat(100000));process.stderr.write(\'y\'.repeat(100000))"', root, 5000);
    assert.equal(bounded.exitCode, 0);
    assert.ok(bounded.stdout.includes("output truncated") && bounded.stderr.includes("output truncated"));
    assert.ok(bounded.stdout.length < 66000 && bounded.stderr.length < 66000);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("validation absorbs stdin/stdout/stderr and late pipe errors while preserving first actionable failure", () => {
  const moduleUrl = pathToFileURL(resolve("dist", "validation.js")).href;
  for (const phase of ["stdin", "stdout", "stderr"]) {
    const script = `
      import assert from 'node:assert/strict';
      import { mock } from 'node:test';
      import { EventEmitter } from 'node:events';
      import { PassThrough } from 'node:stream';
      let child;
      mock.module('node:child_process', { namedExports: {
        execFile() { throw new Error('No unowned process may be killed'); },
        spawn() {
          child = new EventEmitter();
          child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
          queueMicrotask(() => {
            child[${JSON.stringify(phase)}].emit('error', Object.assign(new Error('private stream payload'), {code:'ENOTCONN'}));
            child.emit('error', Object.assign(new Error('private spawn payload'), {code:'ENOENT'}));
            child.stderr.emit('error', Object.assign(new Error('late private payload'), {code:'ENOTCONN'}));
            child.emit('close', 0);
          });
          return child;
        }
      }});
      const { runValidation } = await import(${JSON.stringify(moduleUrl)});
      const result = await runValidation('fixture', 'fixture', 1000);
      assert.equal(result.exitCode, null); assert.equal(result.timedOut, false);
      assert.deepEqual(result.failures, [{phase:${JSON.stringify(phase)},code:'ENOTCONN'}, {phase:'spawn',code:'ENOENT'}]);
      assert.match(result.errorMessage, /^Validator ${phase} failed.*ENOTCONN/);
      assert.match(result.errorMessage, /spawn failed.*ENOENT/);
      assert.doesNotMatch(JSON.stringify(result), /private/);
      await new Promise(resolve => setImmediate(resolve));
      console.log('safe');
    `;
    const result = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--input-type=module", "-e", script],
      { encoding: "utf8", timeout: 10000, maxBuffer: 65536 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), "safe");
  }
});

test("active validator stdin/stdout/stderr errors terminate only the owned process tree", () => {
  const moduleUrl = pathToFileURL(resolve("dist", "validation.js")).href;
  for (const phase of ["stdin", "stdout", "stderr"]) {
    const script = `
      import assert from 'node:assert/strict';
      import { mock } from 'node:test';
      import * as cp from 'node:child_process';
      import { PassThrough } from 'node:stream';
      let child;
      mock.module('node:child_process', { namedExports: {
        execFile: cp.execFile,
        spawn(command, options) {
          child = cp.spawn(command, options);
          child.stdin ??= new PassThrough();
          child.once('spawn', () => child[${JSON.stringify(phase)}].emit('error',
            Object.assign(new Error('private stream payload'), {code:'ENOTCONN'})));
          return child;
        }
      }});
      const { runValidation } = await import(${JSON.stringify(moduleUrl)});
      const result = await runValidation('node -e "setInterval(()=>{},1000)"', process.cwd(), 5000);
      assert.equal(result.exitCode, null); assert.equal(result.timedOut, false);
      assert.deepEqual(result.failures, [{phase:${JSON.stringify(phase)},code:'ENOTCONN'}]);
      assert.match(result.errorMessage, /^Validator ${phase} failed.*ENOTCONN/);
      assert.doesNotMatch(JSON.stringify(result), /private/);
      await new Promise(resolve => child.exitCode !== null || child.signalCode !== null ? resolve() : child.once('close', resolve));
      assert.throws(() => process.kill(child.pid, 0), {code:'ESRCH'});
      console.log('owned cleanup');
    `;
    const result = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--input-type=module", "-e", script],
      { encoding: "utf8", timeout: 10000, maxBuffer: 65536 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), "owned cleanup");
  }
});
