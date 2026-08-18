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

## Chapter 6 — Turning a logged workload into a safe scenario 🟡 Medium
- **Tries to green:** 1.
- **What broke:** the CSV fields contain full request envelopes rather than a
  compact task column, and some envelope context is account-specific.
- **How I found the fix:** extracted the workload shape from the initial task
  and follow-up pattern, then wrote a new self-contained task instead of
  copying transcript content.
- **What did NOT work / discover:** raw log cost/token totals cannot establish
  cross-provider efficiency on their own because their context lengths and
  turn histories differ. The scenario therefore uses them only as qualitative
  evidence for a multi-round workload.
- **Time-to-green:** under one hour.

## Chapter 7 — Configuring a custom model without storing its credential 🟢 Easy
- **Tries to green:** 1 offline implementation pass.
- **What broke:** no provider request was made. The main risk was accidentally
  making a configuration file a credential store.
- **How I found the fix:** the official Copilot SDK BYOK reference separates
  the `ProviderConfig` endpoint/auth fields, so the workshop accepts only
  environment-variable names and resolves values at runtime.
- **What did NOT work / discover:** endpoint compatibility and FW-Kimi-K3's
  exact model identifier cannot be proven without an approved provider smoke
  call. Provider billing data must be reconciled independently.
- **Time-to-green:** under one hour for the offline path.

## Chapter 8 — Removing manual benchmark metadata 🟢 Easy
- **Tries to green:** 3 local iterations (including a Windows `npm.cmd`
  process-launch fix).
- **What broke:** users had to create a task repository and calculate a commit
  SHA/environment fingerprint before a first run, which obscured the core task
  of evaluating an agent.
- **How I found the fix:** made the harness create a local-only baseline commit
  and fingerprint its own workspace at quickstart time.
- **What did NOT work / discover:** the generated baseline is suitable for one
  run. Strict paired comparisons still need candidates to start from copies of
  the same baseline.
- **Time-to-green:** under one hour; 15 offline tests passed.

## Chapter 9 — Designing a routing workshop instead of a leaderboard 🟡 Medium
- **Tries to green:** 1 research-and-design pass.
- **What broke:** “best model” is ambiguous when coding-task complexity,
  deployment availability, tool profiles, region, cost, and latency differ.
- **How I found the fix:** used Foundry deployment/capacity and evaluation
  guidance to define a task-family router with eligibility gates and fallbacks.
- **What did NOT work / discover:** a static model list would become stale and
  cannot represent region/quota constraints. Catalog discovery is a workshop
  prerequisite, not a document constant.
- **Time-to-green:** under one hour.

## Chapter 10 — Generalizing endpoint configuration across model families 🟡 Medium
- **Tries to green:** 2; a local helper-scoping correction was needed.
- **What broke:** an initial default treated the provider name as a protocol;
  that is unsafe for Foundry-hosted partner models because endpoint protocol is
  deployment-specific.
- **How I found the fix:** the official Copilot SDK BYOK contract distinguishes
  `openai`, `azure`, and `anthropic` protocol adapters. The quickstart now
  requires explicit selection and defaults to environment-variable references.
- **What did NOT work / discover:** documentation alone cannot prove the
  protocol exposed by a specific Foundry Anthropic deployment. A non-billable
  or bounded smoke task must confirm it before benchmark execution.
- **Time-to-green:** under one hour; 15 offline tests passed.

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
