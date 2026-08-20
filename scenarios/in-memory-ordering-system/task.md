# In-memory order management core

**Scenario ID:** `in-memory-ordering-system-v1`
**Kind:** Greenfield TypeScript library + small interface, backed entirely by
local in-memory state (no database, no network, no filesystem persistence).

This scenario is self-contained: it does not require a pre-existing starter
repository. The agent creates the project from scratch inside the task
workspace, so you can run it directly (see
[How to run this scenario](#how-to-run-this-scenario)).

## Benchmark purpose

Measure whether a coding agent can design, implement, and repair a small but
non-trivial stateful domain module over multiple rounds. The task exercises
domain modeling, state-machine correctness (order status transitions), total
computation, input validation, tests, and a deterministic build — a more
representative workload than a single code completion.

## Immutable starting state

The task workspace starts effectively empty (only a `BENCHMARK_TASK.md` and a
local git baseline created by the harness). No ordering logic exists yet.

Record the starting repository SHA, Node version, and container/environment
fingerprint in the run contract. Run every candidate from an identical fresh
baseline.

## Round 1 prompt

```text
Build an in-memory order management core in this repository. Work
autonomously: set up the project, plan briefly if useful, write the code, add
tests, and run the configured validation command.

Requirements:
- Create a TypeScript npm project with `npm test` and `npm run build` scripts.
- Implement an OrderStore backed only by local in-memory state (for example a
  Map). Do not use a database, network calls, or on-disk persistence.
- Support these operations:
  - createOrder(customerId): returns a new order with a unique id, status
    "pending", and no items.
  - addItem(orderId, sku, unitPrice, quantity): adds or increases a line item;
    quantity must be a positive integer and unitPrice a non-negative number.
  - removeItem(orderId, sku): removes a line item.
  - orderTotal(orderId): returns the sum of unitPrice * quantity across items.
  - updateStatus(orderId, status): advances the order through the status
    machine pending -> paid -> fulfilled, with cancel allowed from pending or
    paid. Reject any illegal transition.
  - listOrders(status?): returns all orders, optionally filtered by status.
- Reject operations on unknown order ids and mutations of an order that is
  "fulfilled" or "cancelled" with a clear, typed error.
- Expose a small, documented interface (a class or module API is fine; a thin
  CLI wrapper is optional) and keep the domain logic testable without any UI.

Do not ask for clarification. Use sensible defaults and complete the feature.
```

## Round 2 prompt

```text
Act as the implementation reviewer. Exercise the OrderStore against these
cases, then repair every issue you find:

1. orderTotal reflects multiple SKUs and quantity changes (adding the same SKU
   twice increases quantity rather than duplicating the line).
2. addItem rejects a zero/negative/non-integer quantity and a negative
   unitPrice without corrupting existing state.
3. Illegal status transitions are rejected: pending -> fulfilled directly,
   any transition out of "fulfilled", and re-cancelling a cancelled order.
4. cancel is allowed from pending and from paid, and a cancelled or fulfilled
   order rejects addItem/removeItem/updateStatus.
5. listOrders() returns every order and listOrders(status) returns exactly the
   matching subset.
6. Unknown order ids produce a typed error, not an undefined/crash.

Add focused tests for every repaired behavior. Run the configured validation
command and leave the workspace passing.
```

## Round 3 prompt

```text
Perform a final benchmark handoff: inspect the diff, run all configured tests
and the production build, repair failures, and briefly state what was
implemented and what validation ran. Do not add unrelated features.
```

## Deterministic acceptance criteria

The evaluator should use repository tests plus this behavior checklist:

| Requirement | Deterministic evidence |
|---|---|
| Buildable project | `npm run build` exits 0 and emits compiled output. |
| Order creation | Unit test verifies a new order has a unique id, "pending" status, and no items. |
| Total computation | Unit test verifies orderTotal across multiple SKUs and quantity merges. |
| Input validation | Unit test verifies addItem rejects bad quantity/unitPrice and leaves state intact. |
| Status machine | Unit test verifies legal transitions succeed and illegal ones throw. |
| Terminal-state guard | Unit test verifies fulfilled/cancelled orders reject further mutation. |
| Filtering | Unit test verifies listOrders() and listOrders(status) return the correct sets. |

Use the exact command in the scenario contract (normally `npm test && npm run
build`) as the deterministic evaluator. A nonzero exit classifies the run as
`unresolved`; a harness failure must remain a separate outcome.

## Fair-comparison controls

- Hold the initial SHA, Node version, prompt text, rounds, tools, permissions,
  timeout, retries, concurrency, cache policy, and validation command constant
  across candidates.
- Enable streaming and retain all raw event envelopes so TTFT/TPOT availability
  is evidence-based.
- Run each candidate from a separate clean working tree. Do not reuse an
  implementation or SDK session from the other candidate.
- Report all attempts, including timeouts, empty patches, rate limits, tool
  failures, and harness failures; do not compute cost-only statistics by
  silently removing them.

## How to run this scenario

A scenario directory is a **reusable task definition**, not a compiled binary.
The `task.md` above is the human-readable spec; the JSON files next to it are
run configurations. There are two ways to run it:

**A. Quick single-workspace run (fastest to try).** Let the quickstart command
scaffold a throwaway workspace and local git baseline for you, using this
scenario's Round 1 prompt as the task:

```bash
# from the repository root, with FOUNDRY_ENDPOINT and FOUNDRY_API_KEY exported
npm run quickstart -- \
  --task-file scenarios/in-memory-ordering-system/round1.prompt.txt \
  --provider openai \
  --model <your-foundry-deployment>
```

**B. Full multi-round contract run (rigorous / reproducible).** Copy
`benchmark.template.json`, fill in the placeholder fields (`model`,
`workspacePath`, `artifactsDirectory`, and the pinned `repository` values), then
run it. The prompts are already inlined, so no manual copy from `task.md` is
needed:

```bash
npm run bench -- --config ./my-ordering-run.json
```

`workspacePath` must be a clean directory the agent can work in (for a
greenfield task, an empty folder you have `git init`-ed is enough). See
[`fw-kimi-k3.local.example.json`](fw-kimi-k3.local.example.json) for a filled-in
candidate example.
