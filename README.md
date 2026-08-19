# Coding Agent Benchmark Workshop

An offline-testable TypeScript benchmark harness for multi-round coding agents.
GitHub Copilot SDK runs persistent, streaming sessions; Microsoft Foundry
supplies the benchmarked model deployments.

## Before you start

Follow the step-by-step [setup guide](./docs/SETUP_GUIDE.md) before a live
benchmark. It covers Node.js, Git, Foundry resource/deployment preparation,
credentials, local validation, and LLM-judge cost/privacy controls.

## Foundry-only quickstart

Install and build:

```powershell
npm ci
npm test
npm run typecheck
npm run build
```

Set the two shell-only values. The endpoint must be exactly the canonical
Foundry resource root: no project path, `/anthropic`, `/openai/v1`, query, or
alternate host.

```powershell
$env:FOUNDRY_ENDPOINT = "https://<resource-name>.services.ai.azure.com"
$env:FOUNDRY_API_KEY = "set-this-only-in-your-shell"
```

Run a GPT deployment:

```powershell
npm run quickstart -- `
  --task "Build a compact TypeScript application with tests and a production build." `
  --provider openai `
  --model "gpt-5.6-terra"
```

For a Claude deployment, change only the provider and deployment name:
`--provider anthropic --model "claude-sonnet-5"`.

The runner derives `https://<resource>.openai.azure.com/openai/v1` for
`openai`, and `https://<resource>.services.ai.azure.com/anthropic` for
`anthropic`. It records only a SHA-256 endpoint fingerprint. A 404 after
correct routing means to verify deployment identity and availability; it is not
task-code evidence.

## Current MVP

- Two persistent coding-agent rounds, streamed progress, append-only raw and
  normalized event artifacts, deterministic validation, and comparison reports.
- Default reasoning effort is `high`; use `--reasoning-effort` only for an
  intentional comparison cohort.
- Foundry Anthropic requests use an internal `strip-temperature` adaptation.
  Foundry OpenAI requests use `openai-null-refusal-sanitizer`, which removes
  only `refusal: null` in `messages[]` payloads to support strict deployments
  such as FW-Kimi-K3. Adaptations are included in contracts and strict
  comparability checks.
- No credential is written to configuration, contracts, reports, or artifacts.
  Automated tests never make a live model call.

## Supplementary LLM judging

After collecting completed `run.json` artifacts, an opt-in judge can score
their bounded, redacted evidence packet. It is a separate, billable Foundry
request and does not replace deterministic validation or modify run outcomes.

```powershell
npm run evaluate -- `
  --runs .benchmark-runs `
  --provider openai `
  --model "<judge-deployment-name>"
```

The judge uses the same `FOUNDRY_ENDPOINT` and `FOUNDRY_API_KEY` shell values.
Use `--provider anthropic` for a Foundry Claude judge, `--reasoning-effort` to
make an intentional cohort choice, and `--output <path>` to choose the
evaluation JSON location. The output records judge model, protocol adaptation,
prompt version, scores, limitations, and raw judge response. Treat it as
restricted benchmark data: it can contain task prompts and judge text.

See the [Foundry ModelOps workshop](./docs/FOUNDRY_MODELOPS_WORKSHOP.md), the
[scenario](./scenarios/interactive-pathfinding-visualizer/task.md), and the
[developer-experience journal](./docs/WORKING_DIARY.md).
