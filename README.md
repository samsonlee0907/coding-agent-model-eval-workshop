# Copilot coding-agent benchmark workshop

This MVP is a reusable, local TypeScript workshop for measuring **model cost efficiency on realistic multi-round coding tasks**. It uses the official GitHub Copilot SDK as an agent runtime, so each candidate gets one persistent session that can plan, call tools, edit files, run tests, and repair failures across rounds.

It is intentionally not a single-completion benchmark, a cloud deployment, or a SWE-bench downloader. It does not call a live Copilot session during automated tests.

## Prerequisites

- Node.js `^20.19.0` or `>=22.12.0`, required by the Copilot SDK.
- An active GitHub Copilot entitlement, or an officially supported Copilot SDK BYOK setup.
- Either an authenticated Copilot CLI/SDK environment or one of the SDK-supported environment variables: `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, or `GITHUB_TOKEN`. Do not put credentials in config files, source, or artifacts.
- An isolated task workspace. `approve-all` authorizes the agent's tool requests, so use it only in a disposable benchmark workspace.

## Quickstart

```powershell
npm install
npm run build
npm test
Copy-Item benchmark.example.json benchmark.local.json
# Replace every placeholder; do not commit benchmark.local.json.
npm run bench -- --config benchmark.local.json
```

The CLI writes one artifact directory per run: `raw-events.ndjson`, `normalized-events.ndjson`, `run.json`, and `report.md`. Raw events preserve complete SDK envelopes, including ephemeral deltas; they may contain prompts, responses, tool arguments, and tool output.

## Run contract and fairness

Every run persists an immutable, SHA-256-hashed contract containing:

- task prompt, validation command, repository commit SHA, and container/environment fingerprint;
- candidate provider, model, and deployment identity;
- installed SDK version, CLI version policy, and Node version;
- instructions, enabled tools, permission mode, concurrency, retries, timeout, required streaming, and cache policy.

Paired candidates must use the same task and execution contract. `compareRunContracts` marks any task, execution-policy, SDK-version, or CLI-version drift as **not strictly comparable**. Keep candidate identity different only where that is the intended variable.

## What is measured

The collector appends every live SDK event to NDJSON and normalizes durable fields including event ID, parent ID, agent ID, timestamp, event type, and ephemeral status. It captures `assistant.usage`, `session.usage_info`, and attempts the installed SDK's usage metrics RPC through a compatibility adapter.

Reported values include end-to-end time, first tool/edit, deterministic green validation, token/cache/cost fields, and request latency. A metric is explicitly `Unavailable` when the SDK does not provide evidence. In particular, the runner does not derive TTFT from a final response: it requires an observed streaming delta, and uses SDK `timeToFirstTokenMs` when supplied. TPOT requires SDK `interTokenLatencyMs`.

Outcome classes never silently drop failures:

| Class | Meaning |
|---|---|
| `resolved` / `unresolved` | Configured deterministic validation completed with exit 0 / nonzero. |
| `empty_patch` | No edit-like tool call was observed and no evaluator result exists. |
| `rate_limit`, `timeout`, `tool_container_failure`, `harness_failure` | Agent or infrastructure outcomes when a deterministic evaluator result is unavailable. |

## Workshop exercise sequence

1. Create a small, deterministic coding task with a pinned repository SHA and a single validation command.
2. Copy the example contract for candidate A and candidate B; hold task, instructions, permissions, tools, timeout, cache, and container fingerprint constant.
3. Run each candidate from equivalent clean workspaces and retain every artifact directory.
4. Use `renderPairedComparison` or the reports to inspect outcome classes before comparing median cost or latency.
5. Compare all runs first; then separately interpret implementation-phase behavior such as tool calls, repairs, and validation. Never remove timeouts or rate limits from the all-run view.
6. Investigate outliers from their raw event path, model-call events, tool failures, and validation record rather than attributing a cause that the trace does not support.

## Reproducibility and responsible cost controls

- Pin the SDK version and record the CLI version emitted in `session.start`.
- Use an isolated, immutable task checkout and record its commit SHA and container fingerprint.
- Set concurrency to `1`, retries to `0`, and a bounded session timeout for initial comparisons.
- Keep streaming enabled for latency observability; declare cache policy rather than assuming cache parity.
- Use the lowest-cost candidate/model configuration that can complete the task, enforce a per-session timeout, and stop runs after rate-limit evidence.
- Treat raw traces as sensitive benchmark data. Restrict their storage and remove credentials from the environment before sharing.

## Current limitations

- This milestone runs local workspaces only; it does not provision cloud resources or download/run SWE-bench containers.
- The configured `tools` array is supplied as the SDK session's `availableTools`
  allowlist. Use the runtime's actual tool names; an isolated container task
  adapter remains a later workshop extension.
- The first MVP executes one session at a time. It records and applies bounded
  per-round retries, and rejects a contract that declares unsupported
  concurrency or an SDK cache-control policy it cannot enforce.
- A `manual` permission mode is recorded but is intended for an interactive host; the headless CLI should use an explicitly approved sandbox policy.
- Exact model-provider currency pricing is not inferred from a cost multiplier. The report only shows SDK-emitted cost fields.

## Official references

- [GitHub Copilot SDK repository](https://github.com/github/copilot-sdk)
- [Streaming session events](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/streaming-events)
- [Usage and billing metrics](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/usage-and-billing)
