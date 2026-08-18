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
