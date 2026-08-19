# Working Diary — Copilot Coding-Agent Benchmark Workshop (GitHub Copilot SDK)

Log of what we tried, what worked, what failed, and how issues were resolved.
This is a shareable step-by-step trail for the cost-efficiency workshop.

See [COPILOT_COMMANDS_LOG.md](./COPILOT_COMMANDS_LOG.md) for every command/API
call, [TODO.md](./TODO.md) for the coverage matrix, and
[EASE_OF_USE_JOURNEY.md](./EASE_OF_USE_JOURNEY.md) for the human-experience
record.

Repo: `C:\Users\samsonlee\GHCP\copilot-coding-agent-benchmark-workshop`
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
