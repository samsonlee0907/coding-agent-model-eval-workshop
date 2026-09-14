# Coding Agent Model Evaluation Workshop

A TypeScript/npm toolkit for comparing coding-agent runs on the same task and
execution policy. It drives persistent GitHub Copilot SDK sessions through
existing Microsoft Foundry deployments, records evidence, runs deterministic
checks, and produces comparison artifacts.

## Start here

### 1. Install

Prerequisites: Node.js 20.19 or later, npm, Git, and an existing Microsoft
Foundry deployment that supports either the OpenAI or Anthropic wire shape.
The toolkit does not provision cloud resources. `npm install` includes the
Copilot SDK runtime; a separate CLI is optional and can be pinned with
`BENCHMARK_COPILOT_CLI_PATH`.

```powershell
git clone https://github.com/samsonlee0907/coding-agent-model-eval-workshop.git
Set-Location coding-agent-model-eval-workshop
npm install
npm run build
```

### 2. Configure Foundry

Set credentials in the shell only. `FOUNDRY_ENDPOINT` must be exactly the
Foundry **resource root**, with no project path, API path, query string, or
fragment:

```powershell
$env:FOUNDRY_ENDPOINT = 'https://<resource>.services.ai.azure.com'
$env:FOUNDRY_API_KEY = '<your-foundry-api-key>'
```

The selected `--provider` is the required wire shape, not a model brand:

| Provider | Derived inference base |
|---|---|
| `openai` | `https://<resource>.openai.azure.com/openai/v1` |
| `anthropic` | `https://<resource>.services.ai.azure.com/anthropic` |

Use the provider that matches the deployment and record its deployment name in
`--model`. The runner stores an endpoint fingerprint, not the endpoint or key.
See Microsoft’s [model endpoint documentation](https://learn.microsoft.com/azure/foundry/foundry-models/concepts/endpoints)
for deployment prerequisites.

### 3. Try one exploratory task

`quickstart` creates a disposable workspace and local Git baseline. With
`--source`, it copies the supplied starter into that workspace and **does not
modify the original**.

```powershell
npm run quickstart -- --provider openai --model '<deployment-name>' --task 'Build a TypeScript CLI that reverses a string. Add npm tests for ordinary, empty, and non-ASCII input, and make npm test and npm run build pass.'
```

Its output is `.benchmark-runs\quickstart-<id>\artifacts\<run-id>`. Explore
task prompts here; use controlled runs once acceptance criteria and a baseline
are fixed. The [task authoring guide](docs/TASK_AUTHORING_GUIDE.md) provides
copyable prompts and task-file blueprints.

### 4. Run a controlled cohort

Copy [`benchmark.example.json`](benchmark.example.json) once per candidate and
attempt. `workspacePath` is a mutable candidate copy: never point it at the
source baseline or reuse it after a run. Start each attempt from the same
pinned baseline in a clean working copy; use one common `artifactsDirectory`
parent for the cohort.

```powershell
Copy-Item -LiteralPath '.\benchmark.example.json' -Destination '.\candidate-a.json'
Copy-Item -LiteralPath '.\benchmark.example.json' -Destination '.\candidate-b.json'

# Replace every REPLACE_... value, then prepare each workspace from the same baseline.
git -C 'C:\benchmark-workspaces\candidate-a' checkout --detach '<pinned-commit>'
git -C 'C:\benchmark-workspaces\candidate-a' clean -fd
npm run bench -- --config '.\candidate-a.json'

git -C 'C:\benchmark-workspaces\candidate-b' checkout --detach '<pinned-commit>'
git -C 'C:\benchmark-workspaces\candidate-b' clean -fd
npm run bench -- --config '.\candidate-b.json'
```

`contract.task.prompt` is the first work request. `rounds[]` are fixed,
ordered follow-up/review turns. Keep task prompt, baseline, instructions,
round prompts and modes, tools, network policy, runtime, validation command,
and execution settings identical for a strictly comparable cohort.

### 5. Generate decision artifacts

```powershell
$runs = 'C:\benchmark-artifacts\cohort-a'
npm run portfolio -- --runs $runs
npm run prices:refresh -- --runs $runs
npm run report:html -- --runs $runs
```

These write `$runs\model-selection-report.md`, `$runs\pricing-snapshot.json`,
and `$runs\comparison-report.html`. `prices:refresh` detects OpenAI and/or
Anthropic candidates and fetches only their official public pricing pages. Use
`--region <pricing-page-region>` and
`--pricing-model <recorded-model>=<official-label>` to choose the applicable
published scenario.

## Reading a generated report

Read a cohort as an evidence scorecard, not as a single winner. The HTML report
shows provider/model/deployment identity, outcome and validation state,
conformance and artifact-inspection evidence, wall time, output tokens,
agent-turn/model-call activity, and SDK-reported cache share
(`cacheReadTokens / inputTokens`). Its replay is event-specific allowlisted
metadata; it contains no raw messages, tool arguments/results, validation or
probe output.

The report can attach optional fixed-rubric LLM-judge scores, but they never
override deterministic validation. The full judge response is sensitive local
evidence; the HTML contains structured score availability and numeric
dimensions only. A judge consumes Foundry quota:

```powershell
npm run evaluate -- --runs $runs --provider openai --model '<judge-deployment>'
```

Use repeated, equal-contract attempts for reliability, time, and token
conclusions. Preserve failures, timeouts, and missing metrics; an unavailable
value is not zero. Contract drift makes a cohort **not strictly comparable**,
and suppresses the minimum published list-price ranking.

Pricing scenarios are labelled estimates, not invoices or inferred billing
defaults. Azure model/tier/region alternatives remain explicit, and Claude
includes separate 5-minute and 1-hour cache-write scenarios. When contracts
are strictly comparable, the **minimum published list-price** rank is the
lowest complete matching official list-price scenario; it is not a billing
default or replacement for provider telemetry.

Only `comparison-report.html` is the self-contained, publication-oriented
export and it makes no external requests. Raw event logs, `run.json`,
per-run `report.md`, `model-selection-report.md`, validation/probe output,
`llm-evaluation-*.json`, patches, and workspaces are sensitive local evidence
that require separate review before sharing.

## Task design and supported configuration

Use [`benchmark.example.json`](benchmark.example.json) as the controlled-run
schema, and [the task authoring guide](docs/TASK_AUTHORING_GUIDE.md) to design
the task, probes, scorecard, and fixed multi-turn plan. The guide also links
the runnable [in-memory ordering scenario](scenarios/in-memory-ordering-system/task.md).

The default agent tool scope is `read`, `edit`, and `shell`. Optional
[Model Context Protocol](https://modelcontextprotocol.io) servers are declared
under `contract.execution.mcpServers`; their access is part of the immutable
contract. Secret placeholders such as `${ENV_VAR}` expand only from the
process environment, so do not put credentials in config files.

## Scope

- Foundry deployments must use the supported `openai` or `anthropic` wire shape.
- A deterministic `validationCommand` runs once after each session. Optional
  conformance probes and artifact inspection provide independent quality
  evidence.
- Cost, TTFT, TPOT, cache, and other telemetry are reported only when captured;
  missing data is labelled unavailable rather than estimated.
- Automated tests use fixtures and mocks; they do not make live provider calls.
