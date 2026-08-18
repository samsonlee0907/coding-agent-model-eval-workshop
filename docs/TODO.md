# TODO — Copilot Coding-Agent Benchmark Workshop / GitHub Copilot SDK Bake-off

Single source of truth for open workshop work. See
[WORKING_DIARY.md](./WORKING_DIARY.md),
[COPILOT_COMMANDS_LOG.md](./COPILOT_COMMANDS_LOG.md), and
[EASE_OF_USE_JOURNEY.md](./EASE_OF_USE_JOURNEY.md) for related evidence.

**Status legend:** `[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked

---

## Test Plan: phased roadmap

- **Phase 0 — Permission completeness:** use one low-cost authenticated SDK
  session in an isolated local workspace; do not create cloud resources.
- **Phase 1 — End-to-end use:** run a simple multi-round coding task, retain
  event evidence, and validate session persistence.
- **Phase 2 — Architecture patterns:** compare pinned candidate contracts,
  cache behavior, tool policies, and repair loops.
- **Phase 3 — Bigger lift:** add containerized task adapters and SWE-bench
  integration only after this local runner is proven.
- **Phase 4 — Functional depth:** inspect rate limits, timeouts, recovery, and
  bounded concurrency.
- **Phase 5 — Benchmarking:** execute paired candidates on the same immutable
  task contract and include all outcomes.
- **Phase 7 — Destructive lifecycle testing:** none planned; any teardown needs
  explicit approval.

## 0. Feature-coverage map

Source of truth: [GitHub Copilot SDK repository](https://github.com/github/copilot-sdk)
and [GitHub Docs streaming events reference](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/streaming-events).

| # | Feature area | Depth tested so far | Smallest next step |
|---|---|---|---|
| 1 | TypeScript SDK project/build/test setup | ✅ **Used 2026-08-18** — 9 fixture tests, production build, and CLI usage smoke check passed. | Re-run after any SDK version bump. |
| 2 | Persistent streaming session | 🟡 Implemented with tool allowlist and bounded retries, not live-tested | Use one authenticated sandbox task with two message rounds. |
| 3 | Raw SDK event collection | ✅ **Used with fixtures** — identifiers, parent chain, agent ID, and ephemeral state normalized. | Verify a live event artifact. |
| 4 | Usage/cost metrics | ✅ **Used with fixtures**; RPC compatibility adapter implemented. | Verify which fields the installed runtime emits. |
| 5 | Deterministic validation | ✅ **Used with unit fixtures** | Use a local repository command with known expected state. |
| 6 | Paired candidate comparison | ✅ **Implemented/tested** | Run two candidates from equivalent clean task copies. |
| 7 | SWE-bench/container adapter | ❌ Not tried | Design after the local contract and report prove useful. |

## 1. Permission-probe tests (P0)

| # | Primitive | What to try | Permission(s) to watch for | Status |
|---|---|---|---|---|
| 1 | Copilot SDK authentication | Start client and create a no-op local session. | Copilot entitlement/token acceptance; record exact error text. | [ ] |
| 2 | Tool permission policy | Run a harmless read command in isolated workspace. | SDK tool approval policy, not cloud IAM. | [ ] |
| 3 | Usage metrics | Complete a tiny streamed turn and call usage metrics RPC. | Same session entitlement; distinguish unsupported field from denial. | [ ] |

## 2. Functional/behavioral testing (P1)
- [ ] Validate session state continuity across three coding/repair rounds.
- [ ] Validate rate-limit and session-timeout classification from controlled evidence.
- [ ] Compare cached and non-cached runs only with declared cache policy.
- [ ] Verify CLI version extraction from the `session.start` raw event.

## 3. Workshop extensions (P2)
- [ ] Add an isolated container task adapter.
- [ ] Add a SWE-bench task source without bundling the dataset.
- [ ] Add aggregate outlier statistics after multiple retained runs exist.
