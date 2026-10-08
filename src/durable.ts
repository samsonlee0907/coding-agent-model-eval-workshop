import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

export function atomicWrite(path: string, content: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${randomUUID()}`;
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, content); fsyncSync(fd); }
  finally { closeSync(fd); }
  try { renameSync(temporary, path); }
  catch (error) { unlinkSync(temporary); throw error; }
}

export function atomicJson(path: string, value: unknown): void {
  atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJournal<T>(path: string, parse: (value: unknown) => T, repairTornTail = true): T[] {
  if (!existsSync(path)) return [];
  const content = readFileSync(path);
  const lastNewline = content.lastIndexOf(10);
  if (repairTornTail && lastNewline !== content.length - 1) {
    const tail = content.subarray(lastNewline + 1);
    // Only an unterminated tail is recoverable; malformed committed lines are corruption.
    if (tail.length) atomicWrite(`${path}.torn-${randomUUID()}`, tail);
    atomicWrite(path, content.subarray(0, lastNewline + 1));
  }
  return content.subarray(0, lastNewline + 1).toString("utf8").split("\n").filter(Boolean)
    .map((line) => parse(JSON.parse(line)));
}

export function appendJournal(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "a", 0o600);
  try { writeSync(fd, `${JSON.stringify(value)}\n`); fsyncSync(fd); }
  finally { closeSync(fd); }
}

export function acquireOwnership(path: string, recover = false): () => void {
  const token = randomUUID();
  if (recover && existsSync(path)) {
    const owner = JSON.parse(readFileSync(path, "utf8")) as { pid?: number; host?: string };
    if (owner.host !== hostname() || !Number.isSafeInteger(owner.pid)) throw new Error("Cannot verify ownership of stale lock.");
    try { process.kill(owner.pid!, 0); throw new Error("Campaign is owned by an active process."); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
    unlinkSync(path);
  }
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify({ token, pid: process.pid, host: hostname() })); fsyncSync(fd); }
  finally { closeSync(fd); }
  return () => {
    const owner = JSON.parse(readFileSync(path, "utf8")) as { token?: string };
    if (owner.token !== token) throw new Error("Ownership changed; refusing to remove another owner's lock.");
    unlinkSync(path);
  };
}
