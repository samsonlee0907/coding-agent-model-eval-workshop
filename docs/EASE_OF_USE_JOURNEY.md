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

## Chapter 11 — Publishing the workshop evidence trail 🟢 Easy
- **Tries to green:** 1.
- **What broke:** nothing.
- **How I found the fix:** GitHub CLI created the private repository and
  returned its URL; repository metadata and the remote branch SHA confirmed the
  requested state.
- **What did NOT work / discover:** publication validates GitHub repository
  access only. It does not validate a Foundry deployment, catalog permission,
  or a model-provider endpoint.
- **Time-to-green:** immediate.

## Chapter 12 — Reducing Foundry endpoint and run-observability friction 🟢 Easy
- **Tries to green:** 1 after observing successful GPT and Claude runs.
- **What broke:** requiring a separate provider type and endpoint path for each
  candidate made routine comparison setup error-prone, and terminal output could
  appear inactive during long agent turns.
- **How I found the fix:** use one Foundry resource-root environment value,
  retain it for GPT, append `/anthropic` for Claude, and expose compact
  lifecycle events while retaining full raw NDJSON privately.
- **What did NOT work / discover:** the two models still require different
  wire protocols; the convenience layer must preserve an explicit override for
  deployments whose model name does not identify the protocol.
- **Time-to-green:** under one hour; 23 offline tests passed.

## Chapter 13 — Making the happy path safe to copy 🟢 Easy
- **Tries to green:** 1 review-and-hardening pass.
- **What broke:** debug logging could bypass the redacted terminal view, model
  deltas could produce repetitive status lines, and package scripts referenced
  source files unavailable after publication.
- **How I found the fix:** default SDK logging to `none`, track streamed turns
  using stable IDs, require compiled CLI entry points, and put one exact
  resource-root base URL plus copyable commands at the top of the guide.
- **What did NOT work / discover:** monetary decision readiness cannot be
  inferred from one candidate reporting cost; every candidate's resolved
  samples must provide the evidence.
- **Time-to-green:** under one hour; 25 offline tests and package inspection
  passed.

## Chapter 14 — One Foundry URL across GPT and Claude 🟢 Easy
- **Tries to green:** 1 canonicalization pass.
- **What broke:** retaining the services host for GPT made a resource root look
  like a usable OpenAI-compatible inference base, even though GPT requires the
  resource’s `/openai/v1` route on the OpenAI hostname.
- **How I found the fix:** canonicalize a resource root or project endpoint to
  its resource name, then derive the provider-specific base without storing the
  supplied URL in a run artifact.
- **What did NOT work / discover:** a 404 after correct route derivation is
  deployment identity or availability evidence, not a task-code signal.
- **Time-to-green:** under one hour; 32 offline tests passed.

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

## Chapter 14 — Separating deterministic validation from LLM review 🟢 Easy
- **Tries to green:** 1 offline implementation pass.
- **What broke:** the earlier report could describe code-quality limitations but
  could not retain a consistent qualitative review from a selected judge.
- **How I found the fix:** a separate, tool-free judge session keeps the judge
  deployment, prompt version, evidence limits, and response apart from the
  candidate contract.
- **What did NOT work / discover:** an LLM judge cannot replace the deterministic
  validator, visual checks, or human review; malformed JSON is an evaluation
  failure, not a candidate result.
- **Time-to-green:** offline-only; the first real judge request remains a
  budgeted operational check.

## Chapter 13 — Foundry-only endpoint and strict continuation compatibility 🟡 Medium
- **Tries to green:** 1 focused local refactor.
- **What broke:** broad endpoint/provider input obscured the one supported
  workshop deployment contract; FW-Kimi-K3 rejected a Copilot SDK continuation
  containing `refusal: null`.
- **How I found the fix:** Microsoft Foundry endpoint documentation established
  canonical routing, and the retained run artifact isolated the second-turn
  rejected field.
- **What did NOT work / discover:** first-request OpenAI compatibility did not
  prove multi-turn compatibility. The narrow loopback transformer is explicit
  contract evidence, not an invisible workaround.
- **Time-to-green:** offline tests only; no permission or provider request was
  needed.

## Chapter 14 — Giving the judge something real to read 🟢 Smooth
- **Tries to green:** 1 sustained implementation pass across five source files.
- **What broke:** nothing at runtime — the friction was conceptual. Repeated
  attempts to improve *judge output* by improving the *prompt* kept failing,
  because the judge was reasoning about a truncated diff and inferring the
  delivered code rather than reading it.
- **How I found the fix:** inverting the question. Instead of "how do we make
  the judge better at reviewing?", "what is the judge actually being shown?"
  The answer was: not the code. Capturing the final artifact turned a prompt
  problem into a data problem, which is tractable.
- **What did NOT work / discover:** enlarging the diff budget. A bigger diff is
  still the wrong artifact — six candidates' diffs were being truncated, and
  three of them contained no implementation file at all. Also discovered that
  a *green* validation command is much weaker evidence than it looks: two of six
  runs passed their own tests while shipping structurally broken packages, which
  is precisely what the new integrity checks now surface without a model.
- **Editing gotcha:** replacing a function's opening line with `edit` orphans
  its body. Include enough of the body in `old_str` to keep the replacement
  self-contained.
- **Time-to-green:** offline tests, typecheck, build, backfill, and a headless
  browser render check; no permission or provider request was needed.

## Round: conformance probes (task-authored behavioural checks)

- **Rating:** 4/5 to build, 5/5 to author a check.
- **What was easy:** deciding the check protocol. Making each check an
  independent shell command with "exit 0 means the expectation held" removed an
  entire design conversation — no JSON contract, no output parser, no reporting
  convention. Authoring the 9th check took under a minute.
- **What was subtle:** the three-way distinction between *fail*, *weak*, and
  *error*. Collapsing them would have been much easier and much worse: a check
  that could not run says nothing about the artifact, and a check for behaviour
  the prompt never required should not decide a verdict. Getting this right is
  the difference between a probe that is trusted and one that gets ignored.
- **What broke:** the first `conformant` computation counted an errored required
  check as a failure, which directly contradicted the rule the code's own
  comment stated. Writing the timeout test surfaced it. Worth noting that the
  bug survived a typecheck, a build, and 88 passing tests — only a test written
  specifically to pin the documented semantics caught it.
- **Biggest temptation resisted:** letting the probe overwrite `outcome.class`.
  It would have made the report read better and quietly invalidated every run
  recorded before probes existed. Reporting the disagreement is more useful than
  resolving it silently.
- **Payoff:** immediate and larger than expected. Backfilling six existing runs
  found a candidate whose package cannot be imported at all, which had been
  sitting in the report as a clean `resolved` for several rounds. No amount of
  prompt engineering on the judge would have found that; a four-line check did.
- **Scenario-authoring lesson:** the first draft of the probe asserted more than
  the prompt asked for. A probe is only fair if every required check maps to
  something the task actually specified — otherwise the fix belongs in the
  prompt, not in the check. Both were amended together.
- **Time-to-green:** offline tests, typecheck, build, a six-run backfill, and a
  headless browser render; no permission or provider request was needed.
