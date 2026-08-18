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
