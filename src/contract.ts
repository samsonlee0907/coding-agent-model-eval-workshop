import { createHash } from "node:crypto";
import type { ComparisonContract, ExecutionPolicy, RunContract, TaskContract } from "./types.js";

export interface ContractDrift {
  path: string;
  left: unknown;
  right: unknown;
}

export interface ContractComparison {
  strictlyComparable: boolean;
  drift: ContractDrift[];
}

export function immutableContractHash(contract: RunContract): string {
  return hashCanonical(contract);
}

export function compareRunContracts(left: RunContract, right: RunContract): ContractComparison {
  const drift = [
    ...diff("task", left.task, right.task),
    ...diff("execution", left.execution, right.execution),
    ...diff("runtime.sdkVersion", left.runtime.sdkVersion, right.runtime.sdkVersion),
    ...diff("runtime.cliVersion", left.runtime.cliVersion, right.runtime.cliVersion),
  ];
  return { strictlyComparable: drift.length === 0, drift };
}

export function createComparisonContract(
  comparisonId: string,
  left: RunContract,
  right: RunContract,
): ComparisonContract {
  return {
    contractVersion: 1,
    comparisonId,
    sharedTask: left.task,
    sharedExecution: left.execution,
    candidates: [left.candidate, right.candidate],
  };
}

function diff(path: string, left: unknown, right: unknown): ContractDrift[] {
  if (isPlainObject(left) && isPlainObject(right)) {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    return [...keys].flatMap((key) => diff(`${path}.${key}`, left[key], right[key]));
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) {
      return [{ path, left, right }];
    }
    return left.flatMap((value, index) => diff(`${path}[${index}]`, value, right[index]));
  }
  return stableStringify(left) === stableStringify(right) ? [] : [{ path, left, right }];
}

function hashCanonical(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sameTaskContract(left: TaskContract, right: TaskContract): boolean {
  return stableStringify(left) === stableStringify(right);
}

export function sameExecutionPolicy(left: ExecutionPolicy, right: ExecutionPolicy): boolean {
  return stableStringify(left) === stableStringify(right);
}
