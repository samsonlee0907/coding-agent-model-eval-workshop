# Ease-of-Use Journey — Copilot Coding-Agent Benchmark Workshop

This is the human-experience record for the workshop. It complements
[WORKING_DIARY.md](./WORKING_DIARY.md),
[COPILOT_COMMANDS_LOG.md](./COPILOT_COMMANDS_LOG.md), and
[TODO.md](./TODO.md).

Rating scale: 🟢 Easy (worked first/second try, self-explanatory) · 🟡 Medium
(needed iteration or non-obvious knowledge) · 🔴 Hard (multiple failed
attempts, unclear errors, or required external research/support).

---

## Chapter 1 — Finding the correct SDK observability boundary 🟡 Medium
- **Tries to green:** 1 implementation pass after reading two official GitHub
  Docs pages and the official SDK repository.
- **What broke:** no runtime failure occurred; the main uncertainty was whether
  the usage totals API is stable enough to call directly across SDK versions.
- **How I found the fix:** official GitHub Docs identify ephemeral
  `assistant.usage`, `session.usage_info`, and the metrics RPC; installed SDK
  declarations confirmed the currently exposed RPC path.
- **What did NOT work / discover:** the overview documentation alone does not
  make all event envelope fields and compatibility risks obvious. The
  streaming-events reference was needed to establish ID, parent-ID, agent-ID,
  and ephemeral traceability requirements.
- **Time-to-green:** under one hour for the offline-first implementation.

## Chapter 2 — Local package initialization without credentials 🟢 Easy
- **Tries to green:** 1.
- **What broke:** npm warned that native install scripts were pending approval
  for transitive packages.
- **How I found the fix:** npm printed the warning directly.
- **What did NOT work / discover:** the notice does not indicate missing
  Copilot permission. It is explicitly logged as dependency configuration, not
  an IAM/RBAC issue.
- **Time-to-green:** immediate for the local project setup; no approval was
  needed to author or run fixture tests.

## Chapter 3 — Fixture-report validation 🟢 Easy
- **Tries to green:** 2 (one assertion adjustment).
- **What broke:** a test expected `Strictly comparable: Yes`, while the report
  intentionally renders the label with Markdown emphasis.
- **How I found the fix:** the Node test assertion printed the complete actual
  report line, making the discrepancy self-explanatory.
- **What did NOT work / discover:** this did not exercise an SDK runtime;
  fixture tests cannot establish live entitlement or model-metric availability.
- **Time-to-green:** a few minutes.

## Chapter 4 — Declaring versus enforcing benchmark policy 🟢 Easy
- **Tries to green:** 1.
- **What broke:** no failure occurred; the risk was a contract claiming
  concurrency or cache behavior the MVP did not actually enforce.
- **How I found the fix:** the SDK's installed TypeScript declarations exposed
  the tool allowlist, while the documented metrics surface did not provide an
  equivalent cache-control setting for this runner.
- **What did NOT work / discover:** a cache policy cannot be truthfully
  controlled in this MVP, so unsupported values are rejected rather than
  treated as comparable.
- **Time-to-green:** a few minutes.

## Chapter 5 — Compiled CLI discoverability 🟢 Easy
- **Tries to green:** 1.
- **What broke:** nothing; invoking the compiled CLI without `--config` was an
  intentional smoke check.
- **How I found the fix:** the usage message names the exact npm command and
  required configuration argument.
- **What did NOT work / discover:** this validates argument discovery only; it
  does not replace an authenticated SDK-session exercise.
- **Time-to-green:** immediate.

## Open items for this document
- [ ] Rate the first authenticated, isolated SDK session from a human operator's
  perspective, including any entitlement or token error verbatim.
- [ ] Record whether a user can discover the exact runtime/CLI version and
  metrics availability without inspecting generated SDK declarations.

## Chapter summary

The initial friction is documentation synthesis rather than cloud permissions:
the event/usage requirements span the SDK repository and two focused GitHub
Docs pages. The offline fixture architecture keeps that friction out of normal
build/test loops and makes a future entitlement issue easy to identify as
permission-related only when a live SDK error actually says so.
