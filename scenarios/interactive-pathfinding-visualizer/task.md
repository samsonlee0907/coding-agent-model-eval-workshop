# Interactive A* pathfinding visualizer

**Scenario ID:** `interactive-pathfinding-visualizer-v1`
**Source pattern:** Sanitized from the supplied selected coding-agent logs. The
observed workload asked an agent to build a Vite/TypeScript pathfinding
visualizer and then continued through many implementation and repair turns.
No prompts, responses, account details, or credentials from the logs are
included here.

## Benchmark purpose

Measure whether a coding agent can implement and repair an algorithmic,
interactive UI over multiple turns. The task combines repository inspection,
TypeScript design, stateful UI behavior, A* correctness, tests, and build
validation. It is deliberately more representative than a single code
completion.

## Immutable starting state

The evaluator must provide a clean, pinned repository that contains:

- a Vite TypeScript SPA starter with `npm install`, `npm test`, and `npm run
  build` scripts;
- a DOM test environment (for example, Vitest and Testing Library);
- no existing pathfinding implementation;
- a test helper that can create a `20 x 20` grid and inspect its cell state.

Record the starting repository SHA, dependency lockfile SHA, Node version, and
container/environment fingerprint in the run contract. Run every candidate
from a fresh checkout of exactly that state.

## Round 1 prompt

```text
Implement the interactive pathfinding visualizer in this repository. Work
autonomously: inspect the project, plan briefly if useful, edit the code, add
or update tests, and run the configured validation commands.

Requirements:
- Build a compact 20 x 20 grid UI in the existing Vite TypeScript application.
- A cell has exactly one state: empty, wall, start, goal, frontier, settled,
  or path. Provide controls to select the edit mode and click cells to place
  or remove walls, start, and goal.
- Implement A* with four-directional movement and Manhattan distance to the
  goal as an admissible heuristic. Track g, h, and f = g + h internally.
- Provide Step, Run, Reset search, and Clear walls controls. Step performs
  exactly one expansion; Run completes the current search.
- Visually distinguish frontier, settled nodes, and the final path. Surface
  the expansion order in a readable way.
- Show a clear message when start or goal is missing, the goal is unreachable,
  or a requested action cannot proceed.
- Preserve start, goal, and walls when Reset search is used. Clear walls must
  not remove start or goal.
- Keep implementation logic testable outside the UI where practical.

Do not ask for clarification. Use sensible defaults and complete the feature.
```

## Round 2 prompt

```text
Act as the implementation reviewer. Exercise the UI and algorithm against
these cases, then repair every issue you find:

1. On an empty grid from (0,0) to (19,19), Run must find a path with 38 moves.
2. A wall barrier with one gap must route through that gap without visiting
   walls.
3. A fully blocking barrier must report unreachable and must not claim success.
4. Repeated Step calls must expand one node at a time and must not duplicate a
   settled node.
5. Reset search must retain the user's walls/start/goal; Clear walls must
   retain start/goal.
6. Placing a new start or goal must leave exactly one cell in that role.

Add focused tests for repaired behavior. Run the configured validation command
and leave the workspace passing.
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
| Buildable application | `npm run build` exits 0 and creates `dist/index.html`. |
| Algorithm correctness | Unit test verifies a 38-move Manhattan path on an empty 20 x 20 grid. |
| Obstacle handling | Unit test verifies legal routing through a single gap and no wall traversal. |
| Unreachable result | Unit test verifies a fully blocking barrier returns `unreachable`. |
| Incremental search | Unit test verifies one `step()` expands one new node and settled nodes are unique. |
| Reset semantics | UI/state tests verify Reset search and Clear walls preserve the required state. |
| Start/goal uniqueness | UI/state test verifies changing either marker leaves one marker of that type. |

Use the exact command in the scenario contract (normally `npm test && npm run
build`) as the deterministic evaluator. A nonzero exit classifies the run as
`unresolved`; a harness failure must remain a separate outcome.

## Fair-comparison controls

- Hold the initial SHA, lockfile, Node version, prompt text, rounds, tools,
  permissions, timeout, retries, concurrency, cache policy, and validation
  command constant.
- Enable streaming and retain all raw event envelopes so TTFT/TPOT availability
  is evidence-based.
- Run each candidate from a separate clean working tree. Do not reuse an
  implementation or SDK session from the other candidate.
- Report all attempts, including timeouts, empty patches, rate limits, tool
  failures, and harness failures; do not compute cost-only statistics by
  silently removing them.
