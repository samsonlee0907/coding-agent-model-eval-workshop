# Working Diary — Copilot Coding-Agent Benchmark Workshop (GitHub Copilot SDK)

Log of what we tried, what worked, what failed, and how issues were resolved.
This is a shareable step-by-step trail for the cost-efficiency workshop.

See [COPILOT_COMMANDS_LOG.md](./COPILOT_COMMANDS_LOG.md) for every command/API
call, [TODO.md](./TODO.md) for the coverage matrix, and
[EASE_OF_USE_JOURNEY.md](./EASE_OF_USE_JOURNEY.md) for the human-experience
record.

Repo: `coding-agent-model-eval-workshop` (local checkout under your workspace directory)
Stack: GitHub Copilot SDK `1.0.10-preview.0`, TypeScript, npm, Node.js

---

## 2026-08-18

### 15:50 — Workshop MVP initialized
- **What we did:** initialized a TypeScript/npm project and installed the
  official `@github/copilot-sdk` package plus TypeScript test/build tooling.
- **Result:** ✅ project dependencies installed without a platform API call.
- **How the integration was found:** used GitHub's official Copilot SDK
  repository and GitHub Docs for the persistent-session, streaming-event, and
  usage-metrics APIs.
- **Configuration note:** npm reported pending native install scripts for
  `koffi` and `esbuild`. This is a local dependency/configuration state, **not
  a permission issue**. No credential, cloud, or Copilot runtime call was made.

### 15:55 — Persistent-agent benchmark architecture implemented
- **What we did:** added a CLI runner that starts one Copilot client/session,
  enables streaming, delivers multiple sequential rounds, appends raw event
  envelopes to NDJSON, and runs a configured deterministic validation command.
- **Result:** ✅ implementation is isolated behind an SDK adapter and tests use
  fixtures only; no live Copilot session is invoked during testing.
- **How the design was found:** GitHub Docs document event envelope identifiers,
  ephemeral deltas, `assistant.usage`, `session.usage_info`, and usage metrics
  RPCs. The installed SDK declarations confirmed the available TypeScript
  surface.

### 16:00 — Initial evaluation evidence seeded
- **What we did:** added immutable run/comparison contracts, metric derivation,
  outcome classification, self-contained reports, and fixture tests.
- **Result:** ✅ the MVP records unavailable metrics instead of fabricating
  values, including TTFT when streaming deltas are absent.
- **Next up:** run a real benchmark only in an approved, isolated task
  workspace after providing authenticated Copilot SDK access outside the repo.

### 16:05 — Offline build and fixture validation
- **What we did:** ran TypeScript type checking, the targeted node test suite,
  and the production build.
- **Result:** ✅ 9 fixture-driven tests passed and the build completed.
- **How the fix was found:** one report assertion initially expected Markdown
  without its formatting delimiter; the failed assertion showed the actual
  report line directly, and the fixture expectation was corrected.
- **Permission assessment:** this was a local test expectation issue, **not a
  permission issue**. The suite did not start an SDK client or invoke a live
  Copilot session.

### 16:10 — Policy enforcement validation
- **What we did:** wired the declared tool allowlist into SDK session creation,
  added bounded per-round retry handling, and rejected unsupported concurrent
  or cache-control claims rather than recording them silently.
- **Result:** ✅ type checking, 9 fixture tests, and the production build passed.
- **How the fix was found:** the installed SDK TypeScript declarations expose
  `availableTools`; no live session was needed to verify the integration type.
- **Permission assessment:** local-only implementation and test work; **not a
  permission issue**.

### 16:15 — Final runnable-state check
- **What we did:** repeated type checking, fixture tests, and production build,
  then invoked the compiled CLI without configuration to verify its usage path.
- **Result:** ✅ 9 tests passed; the CLI returned its documented configuration
  usage message without starting a live Copilot session.
- **How the fix was found:** the compiled CLI behavior was directly observable.
- **Permission assessment:** local-only; **not a permission issue**.

### 16:20 — Log-derived benchmark scenario added
- **What we did:** inspected the two supplied selected-run CSV exports and
  extracted a sanitized workload pattern: an agent builds a Vite/TypeScript A*
  pathfinding visualizer, then continues through implementation and repair
  turns. Added the scenario contract, prompts, acceptance criteria, and
  fairness controls under `scenarios/interactive-pathfinding-visualizer/`.
- **Result:** ✅ one reusable three-round coding-agent task is ready for a
  future pinned starter repository.
- **How the scenario was found:** directly from the supplied log envelope's
  task description and multi-round shape; account-specific context, prompts,
  responses, and credentials were intentionally excluded.
- **Permission assessment:** reading attached files and authoring local
  documentation only; **not a permission issue**.

### 16:25 — FW-Kimi-K3 BYOK runner support added
- **What we did:** added a non-secret OpenAI-compatible provider configuration
  that resolves the API endpoint and credential from named environment
  variables only. Added a FW-Kimi-K3 local config example, explicit validation,
  and offline tests.
- **Result:** ✅ TypeScript checking, build, and 12 fixture tests passed;
  provider resolution never contacts the endpoint during those tests.
- **How the integration was found:** the official GitHub Copilot SDK BYOK
  documentation defines `provider.type`, `baseUrl`, `apiKey`/`bearerToken`,
  `wireApi`, and the requirement to set `model` explicitly.
- **Permission assessment:** no provider call was made; an unset/invalid future
  provider credential must be treated as configuration/authentication evidence,
  not assumed to be a repository or cloud permission issue.

### 17:30 — No-GitHub quickstart flow added
- **What we did:** added a `npm run quickstart` command accepting a task,
  optional source artifact, and shell-only FW BYOK environment variables. It
  creates a fresh local workspace, makes a local baseline Git commit, derives
  the baseline SHA and local environment fingerprint, and selects available
  test/build scripts after agent work.
- **Result:** ✅ TypeScript checking, production build, and 15 offline tests
  passed. The test creates a local-only Git baseline and does not start a model
  session.
- **How the design was found:** this removes manual benchmark metadata while
  preserving an auditable local baseline. The Copilot SDK's BYOK provider means
  the runtime does not require GitHub authentication for model inference.
- **Permission assessment:** the quickstart baseline uses local Git only; it
  creates no GitHub repository, remote, cloud resource, or credential file.

### 17:45 — Foundry ModelOps routing workshop scope added
- **What we did:** documented a Foundry workshop blueprint covering dynamic
  model/deployment inventory, controlled coding-task families, tool-profile
  isolation, deterministic gates, task-family routing policy, canary rollout,
  and continuous evaluation.
- **Result:** ✅ scope and prerequisites are documented without creating an
  Azure resource or deployment.
- **How the design was found:** applied official Foundry model-deployment,
  capacity, toolbox, and evaluation guidance. The design deliberately avoids
  a static model list because availability, quota, and model features vary by
  region and deployment.
- **Permission assessment:** documentation/research only; **not a permission
  issue**. Foundry catalog/deployment access will require approved Azure access
  when the hands-on workshop begins.

### 18:00 — Multi-provider quickstart generalized
- **What we did:** changed quickstart from an FW-Kimi-K3-specific default to
  explicit candidate provider label, model/deployment identity, provider
  protocol (`openai`, `azure`, or `anthropic`), and environment-variable names.
  Added Foundry/Anthropic connection guidance and made the ModelOps guide the
  repository's primary README entry point.
- **Result:** pending final offline validation and publication.
- **How the design was found:** the official Copilot SDK BYOK reference defines
  the three provider protocol types. Endpoint protocol—not model brand—selects
  the provider type; Foundry-hosted Anthropic deployments need their documented
  endpoint protocol confirmed before use.
- **Permission assessment:** no provider or Foundry request was made. Missing
  deployment access or endpoint credentials are configuration/authentication
  blockers, not automatically a GitHub permission issue.

### 18:10 — Generalized provider validation complete
- **What we did:** ran TypeScript checking, all fixture tests, production build,
  and diff whitespace validation after adding generic quickstart options.
- **Result:** ✅ 15 tests passed. The suite verifies OpenAI-compatible provider
  resolution, Anthropic wire-format rejection, generic quickstart parsing, and
  local-only baseline creation.
- **How the fix was found:** a test initially exposed helper declarations
  accidentally scoped inside the argument parser; the type checker and fixture
  error made the local source issue explicit.
- **Permission assessment:** this was a local code issue, **not a permission
  issue**. No model, Foundry, GitHub, or cloud API was invoked.

### 18:15 — Generalized workshop published
- **What we did:** created and pushed the private GitHub repository
  `samsonlee0907/coding-agent-model-eval-workshop`.
- **Result:** ✅ `main` was pushed and remote privacy was verified.
- **How the result was verified:** GitHub CLI repository metadata reported
  `isPrivate: true`, and `git ls-remote` returned the committed `main` SHA.
- **Permission assessment:** GitHub CLI access with `repo` scope succeeded; no
  Foundry or model-provider permission probe was performed.

### 10:30 — Foundry quickstart and live-progress usability refinement
- **What we did:** added a single `FOUNDRY_ENDPOINT`/`FOUNDRY_API_KEY` quickstart
  path for the observed working GPT and Claude configurations. The GPT provider
  retains the resource root and the Anthropic provider appends `/anthropic`.
  Added `high` default reasoning effort with an explicit override and a concise,
  redacted streaming terminal progress view.
- **Result:** ✅ 23 offline tests, type checking, production build, and the
  all-run portfolio report completed successfully.
- **How the design was found:** incorporated successful local-run behavior:
  stripping `/anthropic` yielded the working GPT base, while Claude required
  the suffix. The SDK’s documented `reasoningEffort` session option is recorded
  in the immutable execution policy.
- **Permission assessment:** local implementation and artifact analysis only;
  **not a permission issue**. No new Foundry, model-provider, or GitHub request
  was made.

### 10:32 — Implementation hardening and command-reference review
- **What we did:** reviewed the current provider, reporting, progress, contract,
  and package wiring. Removed forced SDK debug output, deduplicated progress by
  stable turn/message identity, made request-sanitization policy comparison
  drift, required cost evidence for every candidate’s resolved samples, and
  shipped compiled quickstart/portfolio entry points.
- **Result:** ✅ 25 offline tests, type checking, build, package-content
  inspection, and 11-run report generation passed.
- **How the design was found:** a focused source review identified terminal-log
  redaction, noisy delta reporting, incomplete cost gating, and installability
  gaps. The command reference now states the exact resource-root base URL and
  rejects ignored conflicting endpoint flags.
- **Permission assessment:** local source and package inspection only; **not a
  permission issue**. No model request or cloud resource action occurred.

### 13:50 — Single-base-URL Foundry inference derivation corrected
- **What we did:** replaced host-preserving endpoint handling with canonical
  resource-name extraction. One Foundry resource root or project endpoint now
  derives `https://<resource>.openai.azure.com/openai/v1` for GPT and
  `https://<resource>.services.ai.azure.com/anthropic` for Claude.
- **Result:** ✅ 32 offline tests cover services and OpenAI roots, project
  endpoints, both provider protocols, invalid hosts/paths, and URL redaction.
- **How the design was found:** the prior GPT root assumption was invalid for
  the documented OpenAI-compatible route. The shared adapter now rejects
  non-Foundry or malformed paths before a provider request rather than passing
  them through.
- **Permission assessment:** implementation and fixture validation only; **not
  a permission issue**. No credential, provider, or cloud request was used.

### 14:10 — Foundry-only contract and FW-Kimi-K3 continuation adaptation
- **What we did:** replaced generic/custom provider input with exact
  `openai|anthropic` Foundry provider selection, fixed shell-only
  `FOUNDRY_ENDPOINT`/`FOUNDRY_API_KEY`, and canonical resource-root validation.
  Added a loopback OpenAI request transformer that removes only null
  `messages[].refusal` fields, including nested continuation arrays.
- **Result:** ✅ offline tests validate strict endpoint rejection, both derived
  routes, credential requirements, proxy forwarding, null-only preservation,
  contract drift, report disclosure, and no endpoint leakage.
- **How the design was found:** the FW-Kimi-K3 artifact recorded a successful
  first request followed by the documented rejection
  `messages[2].refusal: None`; the narrow adapter preserves all non-null
  request data.
- **Permission assessment:** local implementation and tests only; **not a
  permission issue**. No credential or live provider request was used.

### 15:20 — Separate LLM-judge evaluation and tool-filter cleanup
- **What we did:** added an opt-in Foundry judge command for completed run
  artifacts. It sends bounded, explicitly untrusted evidence to a tool-free
  judge session, validates strict JSON scores, and writes a separate evaluation
  artifact without changing deterministic outcomes. Replaced the unsupported
  `builtin:edit` tool filter with `builtin:apply_patch`.
- **Result:** ✅ 36 offline tests, type checking, production build, and diff
  whitespace validation passed; no judge or candidate provider request was made.
- **Permission assessment:** local source work only; **not a permission
  issue**.

### 16:00 — MCP tool support and ordering-system scenario
- **What we did:** added optional `contract.execution.mcpServers` so a benchmark
  can attach Model Context Protocol servers (web fetch/search or user skills)
  alongside the built-in `read | edit | shell` tools. The runner exposes MCP
  tools via `mcp:*`, expands `${ENV_VAR}` placeholders in server specs at launch
  so secrets never enter config files or the immutable contract, and folds MCP
  access into contract drift detection. Configs without `mcpServers` are
  byte-identical to before. Replaced the pathfinding scenario with a
  self-contained `in-memory-ordering-system` scenario (order state machine using
  local in-memory storage) with inlined prompts and a ready-to-run quickstart
  prompt file. Added `benchmark.mcp.example.json`.
- **Result:** ✅ 46 offline tests, type checking, and production build passed;
  new tests cover the MCP allowlist, `${ENV_VAR}` expansion (and the missing-var
  failure), and MCP-driven contract drift. No live provider or MCP request was
  made during testing.
- **How the design was found:** the installed Copilot SDK declares
  `SessionConfig.mcpServers`, `MCPServerConfig`, and `ToolSet.addMcp`; the
  contract hash/drift already walk the whole `execution` object, so an optional
  field is captured automatically.
- **Permission assessment:** local implementation and fixture validation only;
  **not a permission issue**. The `${ENV_VAR}` design keeps MCP credentials in
  the environment, never in tracked files.

### 18:30 — Full-artifact judge review and derived-efficiency reporting
- **What we did:** closed the report's central evidence gap. Until now the LLM
  judge only ever saw a truncated *diff*, which shows what changed but cannot
  show whether the delivered code is correct. Added
  `src/artifact-inspection.ts`, a deterministic inspector that captures each
  run's final workspace after validation (file/LOC inventory by role, export
  surface, persisted sources) plus three integrity checks chosen specifically
  because **a passing test command hides them**: manifest entry points that
  resolve to nothing, installed dependencies the manifest's own range
  disallows, and test files collected from build output (which double-counts
  assertions). Rewrote the judge to prompt `benchmark-judge-v3`: it now reads
  line-numbered final sources, is handed the integrity results as established
  facts it must not re-derive, and must anchor every finding to `file:line` —
  citations the harness independently re-verifies and badges when unresolvable.
  Added an **Agent efficiency profile** report section rendering metrics the
  collector already captured but nothing displayed (time to first tool call /
  first edit / green test, TPOT, cache write tokens, cache hit share, tokens per
  tool call, tool calls per edit), and changed a reported cost of `0` to render
  as **Unpriced** so an absent price signal is never averaged with real figures.
- **Result:** ✅ 88 offline tests, type checking, and the production build
  passed. Backfilling the six retained runs, the inspector reproduced by pure
  static means the same defects an earlier manual review had found by hand:
  FW-Kimi-K2.6 shipped three out-of-range dependencies (including a `vitest`
  pre-release) plus a shadow test file under `dist/`, and GPT-5.6-Luna declared
  a `main` entry point the build never emits. Both candidates had validated
  green. Report regenerated and checked in a headless browser: 0 page errors,
  no horizontal overflow.
- **How the design was found:** the division of labour resolved the problem, not
  a better prompt. Deterministic checks establish *facts*; the judge explains
  *consequences*. Handing the judge verified facts plus real source removes the
  two things that made earlier scores unreliable — guessing from a diff, and
  re-deriving what the harness can simply measure.
- **Notable evidence:** claude-opus-5 renders `Unavailable` for both
  edit-derived efficiency rows. That is correct, not a bug: it wrote files
  through `powershell` rather than the `edit` tool, so the harness abstains
  instead of inventing a denominator. Exactly the behaviour the "never estimate"
  rule is for.
- **Permission assessment:** local implementation, backfill, and offline fixture
  validation only; **not a permission issue**. The v3 prompt has not yet been
  exercised against a live judge because no Foundry credentials are configured
  in this environment — a **configuration** gap, not a denial.

### 20:10 — Conformance probes: closing the "green but wrong" gap

- **Goal:** the previous round gave the judge the real source, but every
  automated signal still traced back to the candidate's *own* test suite. A
  candidate that writes agreeable tests validates green regardless of whether it
  met the spec. Close that with task-authored behavioural checks the agent never
  sees.
- **Design:** a probe is a list of independent shell commands declared on the
  task contract and run in the delivered workspace after validation. Exit 0 means
  the expectation held — no output protocol, no reporting contract, so authoring
  a check costs a few lines. Severity is `required` (a failure means
  non-conformant) or `advisory` (recorded as *Weak*, never decides the verdict);
  a check that could not execute records *Error* and is never counted against the
  artifact, because absence of evidence is not evidence of a defect. A failed
  `setupCommand` short-circuits everything to *Error*: an unbuildable artifact is
  different evidence from a wrong one.
- **The one judgement call:** the probe deliberately does **not** rewrite
  `outcome.class`. Outcome is documented as deriving from the configured
  validation command, and silently redefining it would break comparability with
  every run already recorded. The conformance verdict is reported separately and
  a green-but-non-conformant run is called out as a **divergence** — banner,
  decision-summary card, and run-table column.
- **Result:** ✅ 109 offline tests (up from 88), type check, and build all pass.
  Wrote a 9-check probe for the ordering-system scenario and backfilled the six
  retained runs. It immediately paid for itself:
  - **GPT-5.6-Luna failed 8 of 8 required checks** — its manifest declares
    `dist/order-store.js`, which the build never emits, so *no consumer can
    import the package at all*. It had validated **green** and is recorded as
    `resolved`. This is the divergence banner's reason to exist, demonstrated on
    real data rather than a fixture.
  - **FW-Kimi-K2.6 failed the advisory `no-state-leak` check** — mutating an
    object returned by `listOrders()` corrupts the store, because the returned
    object aliases internal state. A genuine defect its own suite missed. Marked
    advisory because the prompt never required defensive copying, so it is
    recorded as a weakness without being held against the verdict.
  - The remaining four candidates were fully conformant.
- **Fairness correction:** the probe asserts that the package is importable
  through its own declared entry point and exports a constructible `OrderStore`.
  The original prompt only asked for "a small, documented interface", so that
  requirement was added explicitly to both `task.md` and the round-1 prompt.
  A probe may only assert what the task actually specified; anything else belongs
  in `advisory`.
- **Bug found while writing tests:** the first `conformant` computation treated a
  required check that *errored* as a failure, contradicting the documented rule
  that an unexecutable check is never evidence against the artifact. Fixed to
  return `null` (*Inconclusive*) when any required check could not run, and the
  timeout test now pins that behaviour.
- **Permission assessment:** local implementation, backfill, and offline fixture
  validation only; **not a permission issue**. The conformance-aware judge prompt
  still has not met a live model — no Foundry credentials in this environment,
  which remains a **configuration** gap, not a denial.
