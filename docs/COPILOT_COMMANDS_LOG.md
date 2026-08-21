# Copilot Commands Log

Every CLI command and underlying SDK/agent API call run in this workspace.
This distinguishes real authorization failures from local dependency,
configuration, model, billing, or quota issues.

See [WORKING_DIARY.md](./WORKING_DIARY.md),
[TODO.md](./TODO.md), and
[EASE_OF_USE_JOURNEY.md](./EASE_OF_USE_JOURNEY.md).

Legend: ✅ succeeded · ❌ failed (permission or other error) · ⚠️ partial ·
ℹ️ local-only, no platform call

| Date/Time (local) | Command | Permission/API involved | Result | Notes |
|---|---|---|---|---|
| 2026-08-18 15:50 | `npm init -y` | None | ℹ️ | Local project initialization. |
| 2026-08-18 15:50 | `npm install @github/copilot-sdk@1.0.10-preview.0` | npm registry package download | ✅ | Downloaded official SDK; no Copilot runtime/auth API call. |
| 2026-08-18 15:51 | `npm install -D typescript tsx @types/node` | npm registry package download | ⚠️ | npm reported pending install-script approval for `koffi` and `esbuild`; **not a permission issue**, only local dependency configuration. |
| 2026-08-18 15:55 | fixture-driven `npm test` planned | None | ℹ️ | Tests deliberately do not start a Copilot session or require credentials. |
| 2026-08-18 16:00 | Copilot SDK usage-event implementation | No live API call | ℹ️ | Based on GitHub Docs and installed SDK declarations only. |
| 2026-08-18 16:05 | `npm run typecheck` | None | ✅ | Local TypeScript validation passed. |
| 2026-08-18 16:05 | `npm test` | None | ✅ | 9 fixture-driven tests passed; no live Copilot session was started. |
| 2026-08-18 16:05 | `npm run build` | None | ✅ | Local production build passed. |
| 2026-08-18 16:10 | `npm run typecheck; npm test; npm run build` | None | ✅ | 9 tests and production build passed after policy enforcement changes. |
| 2026-08-18 16:15 | `npm run typecheck; npm test; npm run build; node dist\cli.js` | None | ✅ | 9 tests/build passed; CLI printed its config usage path and made no platform call. |
| 2026-08-18 16:20 | Local CSV analysis of supplied benchmark logs | None | ℹ️ | Read attached local files only; no model/provider API call. Derived a sanitized scenario without retaining account-specific content. |
| 2026-08-18 16:25 | FW-Kimi-K3 BYOK adapter implementation | No provider API call | ℹ️ | Configuration accepts only environment-variable names; no credential value entered, committed, or sent. |
| 2026-08-18 16:30 | `npm run typecheck; npm test; npm run build` | None | ✅ | 12 fixture tests passed for the BYOK adapter and existing runner; no provider API call. |
| 2026-08-19 17:30 | Quickstart implementation | Local Git only | ℹ️ | Added local baseline/workspace flow; no GitHub or model-provider call. |
| 2026-08-19 17:40 | `npm run typecheck; npm test; npm run build` | None | ✅ | 15 offline tests passed, including local baseline creation and auto-validation. |
| 2026-08-19 17:45 | Foundry workshop scope research | Public documentation only | ℹ️ | No Azure resource, deployment, model invocation, or catalog operation performed. |
| 2026-08-19 18:00 | Multi-provider quickstart generalization | No provider API call | ℹ️ | Added OpenAI/Azure/Anthropic protocol selection and non-secret environment-variable references only. |
| 2026-08-19 18:10 | `npm run typecheck; npm test; npm run build` | None | ✅ | 15 offline tests passed for generic provider selection and local quickstart. |
| 2026-08-19 18:15 | `gh repo create coding-agent-model-eval-workshop --private --source . --push` | GitHub repository creation/push (`repo` scope) | ✅ | Created private repository and pushed `main`; remote metadata verified private. |
| 2026-08-19 10:30 | `npm test; npm run typecheck; npm run build; npm run portfolio -- --runs .benchmark-runs` | None | ✅ | 23 offline tests, TypeScript validation, build, and 11-run report generation passed; no live provider request. |
| 2026-08-19 10:32 | `npm test; npm run typecheck; npm run build; npm run portfolio -- --runs .benchmark-runs; npm pack --dry-run` | None | ✅ | 25 offline tests, compiled CLI checks, report generation, and package-content inspection passed; no live provider request. |
| 2026-08-19 13:50 | `npm test; npm run typecheck; npm run build` | None | ✅ | 32 offline tests passed for Foundry base/project URL derivation and report redaction; no live provider request. |
| 2026-08-19 14:10 | Foundry-only provider and FW-Kimi-K3 compatibility implementation | No provider API call | ℹ️ | Fixed `FOUNDRY_ENDPOINT`/`FOUNDRY_API_KEY` contract; local proxy removes only null OpenAI message refusals. |
| 2026-08-19 14:10 | `npm test` | None | ✅ | 27 offline tests passed; no model call, credential use, or cloud resource action. |
| 2026-08-19 15:20 | LLM-judge command and tool-filter cleanup | No provider API call | ℹ️ | Added a tool-free Foundry judge design with bounded evidence; no live judge request was made. |
| 2026-08-19 15:25 | `npm test; npm run typecheck; npm run build; git diff --check` | None | ✅ | 36 offline tests passed after judge artifact, secret-boundary, repeat-cohort, and tool-filter regression coverage. |

## Currently confirmed-working permissions
- None tested. This milestone deliberately made no live Copilot, cloud, or
  repository API calls.

## Currently confirmed-blocked / needs a grant
- None. No permission-denied response has been observed.

## Confirmed NOT a permission gap (so nobody re-files it as one)
- npm's pending native install-script notice for `koffi`/`esbuild` is a local
  dependency/configuration issue; it is not IAM/RBAC or Copilot entitlement
  evidence.
- The initial report-test assertion mismatch was a local Markdown expectation
  issue, not an SDK, API, or permission failure.

## Not yet tested
- Copilot CLI/SDK authentication using an entitled account or supported BYOK.
- SDK session creation, tool permission handling, live streaming events, and
  usage metrics against an isolated benchmark workspace.

## 2026-08-20 — Full-artifact judge review and derived-efficiency reporting

| # | Command | Purpose | Result | Permission issue? |
|---|---------|---------|--------|-------------------|
| 1 | `npm run typecheck` | Type-check the artifact inspector, v3 judge, and new report section. | ✅ Clean. | No |
| 2 | `node --import tsx --test --test-reporter=tap "test/*.test.ts"` | Full offline suite including 17 new tests. | ✅ 88 pass / 0 fail. | No |
| 3 | `npm run report:html -- --runs .benchmark-runs` | Regenerate the comparison report over the six retained runs. | ✅ 6 runs, 6 judged scores, report written. | No |

**Notes.** No live provider, judge, or MCP request was made. The v3 judge prompt
remains unexercised against a real model because `FOUNDRY_ENDPOINT` /
`FOUNDRY_API_KEY` are unset in this environment — a **configuration** gap, not a
permission denial. Run `npm run evaluate -- --runs .benchmark-runs --provider
openai --model "<judge-deployment>"` followed by `npm run report:html -- --runs
.benchmark-runs` to produce and render a v3 review.

## 2026-08-20 — Conformance probes

| # | Command | Purpose | Result | Permission issue? |
|---|---------|---------|--------|-------------------|
| 1 | `node scenarios/in-memory-ordering-system/conformance/probe.mjs <check>` | Exercise each of the 9 task-owned checks directly against the six delivered workspaces. | ✅ Four candidates 9/9; FW-Kimi-K2.6 failed the advisory state-leak check; GPT-5.6-Luna failed all 9. | No |
| 2 | `node --import tsx --test --test-reporter=tap "test/conformance.test.ts"` | Pin the pass/weak/fail/error semantics, setup short-circuit, and loader back-compat. | ✅ 16 pass / 0 fail. | No |
| 3 | `npm run typecheck` | Type-check the probe engine, contract types, runner wiring, and report section. | ✅ Clean. | No |
| 4 | `node --import tsx --test --test-reporter=tap "test/*.test.ts"` | Full offline suite after adding 21 conformance tests. | ✅ 109 pass / 0 fail. | No |
| 5 | `npm run report:html -- --runs .benchmark-runs` | Regenerate the report with the conformance matrix, divergence banner, and decision card. | ✅ 6 runs, 7 sections, 0 page errors, no horizontal overflow. | No |

**Notes.** No live provider, judge, or MCP request was made; every check ran as a
local child process with `FOUNDRY_API_KEY` / `FOUNDRY_ENDPOINT` stripped from its
environment so candidate code never sees benchmark credentials. The
conformance-aware judge prompt is still unexercised against a real model because
those variables are unset here — a **configuration** gap, not a permission
denial. Run `npm run evaluate -- --runs .benchmark-runs --provider openai --model
"<judge-deployment>"` followed by `npm run report:html -- --runs .benchmark-runs`
to score the candidates with conformance evidence attached.
