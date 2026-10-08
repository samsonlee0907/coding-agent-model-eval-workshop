# Coding Agent Model Evaluation Workshop

A TypeScript/npm toolkit for user-defined, single- or multi-task coding-agent
benchmarks. It drives persistent GitHub Copilot SDK sessions through existing
Microsoft Foundry deployments, pins task and evaluator evidence, supports
resumable campaigns, and publishes portable offline reports. Task types and
categories are optional user metadata, not a bundled benchmark dataset.

## Start here

### 1. Install

| Prerequisite | Required for | Notes |
|---|---|---|
| Node.js 20.19+ (including npm) | Installation and all commands | npm ships with Node.js. |
| Git | Cloning and controlled baseline preparation | Make it available on `PATH`. |
| Network access | `npm install`, live Foundry runs, and `prices:refresh` | Pricing refresh contacts only official pages for detected providers. |
| Microsoft Foundry resource and deployment | Live runs | Use an existing OpenAI- or Anthropic-compatible deployment; this toolkit does not provision cloud resources. |
| `FOUNDRY_ENDPOINT` and selected authentication | Live runs and optional judge calls | Key mode requires `FOUNDRY_API_KEY`; Entra uses an explicitly selected Azure Identity credential. |
| GitHub Copilot SDK | All runs | `npm install` installs `@github/copilot-sdk`, including its bundled Copilot CLI runtime. |
| Standalone Copilot CLI | Optional | Not required. Use only to intentionally override or pin the runtime with `BENCHMARK_COPILOT_CLI_PATH` or a `copilot` executable on `PATH`. |
| Docker Linux daemon and a prepared digest-pinned image | Isolated execution only | No automatic image pull or trusted-host fallback; see [campaign and publication guide](docs/CAMPAIGNS_AND_PUBLICATION.md). |

No GitHub Copilot subscription or standalone Copilot CLI installation is
required for Foundry-backed runs.

```powershell
git clone https://github.com/samsonlee0907/coding-agent-model-eval-workshop.git
Set-Location coding-agent-model-eval-workshop
node --version
npm --version
git --version
npm install
npm run build
npm test
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

Omitted `auth` preserves **key mode**; omitted `wireApi` preserves OpenAI
**completions**. Select Responses explicitly when supported by your deployment.
For Entra, no API key is required:

```powershell
az login --tenant '<intended-tenant-id>'
# Keep this explicitly signed-in CLI account stable throughout a campaign.
npm run quickstart -- --provider openai --model '<deployment>' --wire-api responses --auth entra --credential azure-cli --tenant-id '<intended-tenant-id>' --task 'Create a small string-reversal CLI and deterministic tests.'
```

For `bench` and campaign candidates, configure
`contract.foundryProvider.auth` as
`{"mode":"entra","credential":"azure-cli","tenantId":"<tenant-uuid>"}`.
`managed-identity` optionally takes a user-assigned `clientId`;
`workload-identity` requires `tenantId`, `clientId`, and the host's
`AZURE_FEDERATED_TOKEN_FILE`. The toolkit never changes identities or falls
back to a key after an auth failure. Azure Identity owns token caching and
refresh through the pinned SDK's experimental bearer callback, following its
[exact-version guide](https://github.com/github/copilot-sdk/blob/v1.0.10-preview.0/docs/setup/azure-managed-identity.md).

Inference permissions are endpoint-specific: Azure OpenAI documents
**Cognitive Services OpenAI User**; direct Foundry model inference documents
**Cognitive Services User**. Project/agent roles are not substitutes for a
resource's inference role. Management Contributor or `az login` is not proof
of data-plane permission. No roles, deployments, resources, or key policies
are changed by this toolkit.

```powershell
npm run doctor -- --config '.\candidate-a.json'
# Optional token-only check; contacts identity services, never model inference.
npm run doctor -- --config '.\candidate-a.json' --acquire-auth
```

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

### 4. Run a controlled cohort (trusted local by default)

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

Without `isolation`, tools and validators can access host files, credentials,
Azure CLI caches, and network resources. Scrubbing the two Foundry environment
variables is **not credential isolation**. Use the container profile for
credential-isolated candidate execution, with its documented prerequisites.

### 5. Generate decision artifacts

```powershell
$runs = 'C:\benchmark-artifacts\cohort-a'
npm run portfolio -- --runs $runs
npm run prices:refresh -- --runs $runs
npm run report:html -- --runs $runs
```

These write `$runs\model-selection-report.md`, `$runs\pricing-snapshot.json`,
and `$runs\benchmark-report\index.html` plus consistent JSON/CSV exports.
The **default HTML destination changed to a portable folder**. Existing
single-file calls remain compatible:

```powershell
npm run report:html -- --runs $runs --output "$runs\comparison-report.html"
npm run report:html -- --runs $runs --bundle "$runs\report-v2" --zip
```

Portable publication refuses an existing folder/ZIP; choose a new versioned
destination. Explicit single-file output is atomically replaced only after
rendering succeeds. `prices:refresh` detects OpenAI and/or
Anthropic candidates and fetches only their official public pricing pages. Use
`--region <pricing-page-region>` and
`--pricing-model <recorded-model>=<official-label>` to choose the applicable
published scenario.

## Resumable user-defined campaigns

The compact [custom campaign](examples/custom-campaign/campaign.json) has two
independently authored tasks and arbitrary deployment placeholders. Replace
the deployments and review all bounds before live work. Preparation, status,
and reporting need no cloud credentials and do not call a model:

```powershell
$state = '.benchmark-runs\custom-campaign'
npm run campaign -- prepare --spec '.\examples\custom-campaign\campaign.json' --directory $state
npm run campaign -- status --directory $state
npm run campaign -- report --directory $state --output '.\reports\prepared-preview' --zip

# Explicitly paid operations, only after credentials/deployments/bounds are reviewed:
npm run campaign -- run --directory $state --allow-paid
npm run campaign -- resume --directory $state --allow-paid
npm run campaign -- report --directory $state --output '.\reports\completed-v1' --zip
```

Preparation snapshots immutable inputs, prompts, rounds, runtime, evaluator
policy, optional private grader assets and optional pricing. Run/resume uses
owned durable journals, per-deployment pacing, memory admission and finite
request/token/USD reservations. It skips clean content FAILs as well as PASSes,
finalizes retained outputs without inference, and denies ambiguous request
replay. Follow the [campaign and publication guide](docs/CAMPAIGNS_AND_PUBLICATION.md)
for recovery, isolation, calibration, publication manifests and limits.

## Reading a generated report

The default report is titled **Coding Agent Model Benchmark**. Read it as an
evidence scorecard, not as a single winner. Methodology precedes an interactive
task-by-model matrix. The default selected attempt is the **latest clean
completion, including content FAILs, not the latest PASS**. Missing,
interrupted, evaluator-error and ungraded cells remain visible. A newer
interruption does not erase an earlier completion. Candidate-owned validation
and independent required acceptance are separate; validation alone is not PASS.

Matched task-type charts use equal graded coverage and recorded comparability
signatures. Sparse results are descriptive, not production-routing claims.
Inspectors show contract/prompt/round/grade/workspace bindings, approved
previews and metadata replay. Supplementary legacy details retain all-attempt
evidence, pricing and judge information.

The HTML report
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

The portable report folder/ZIP and explicit single HTML are publication-oriented
exports and make no external requests when opened. Default publication includes
metadata only; review task labels too. Source/output contents and active
original downloads require an explicit hash-bound publication manifest.
Raw event logs, `run.json`,
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
- Local acceptance includes the pinned SDK/CLI with a fake localhost Responses
  provider and offline Edge checks. Real deployment/RBAC/key/Entra behavior and
  real container enforcement require separately authorized live acceptance.
