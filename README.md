# Coding Agent Model Evaluation Workshop

A TypeScript/npm toolkit for user-defined, single- or multi-task coding-agent
benchmarks. It drives persistent GitHub Copilot SDK sessions through existing
Microsoft Foundry deployments, pins task and evaluator evidence, supports
resumable campaigns, and publishes portable offline reports. Task types and
categories are optional user metadata, not a bundled benchmark dataset.

## Choose your workflow

**Docker is not required to use this repository.** It is required only when
you explicitly configure container isolation. Choose the execution boundary
before running candidate code:

| Operation | Prerequisites after installation | Docker / Azure authentication |
|---|---|---|
| Open an already generated offline report | A browser; no Node.js or server needed | Neither |
| Generate reports from saved runs; campaign status/report | Node.js/npm and saved evidence | Neither; no inference |
| Prepare a campaign; run local-only `doctor` | Node.js/npm, readable inputs and installed SDK/CLI | Neither for trusted-local configs; isolated `doctor` also inspects Docker/image |
| Trusted-local quickstart, `bench`, or campaign run/resume | Above, task tools/dependencies, reachable existing Foundry deployment and selected auth | No Docker; key or Entra |
| Isolated campaign run/resume or private grading | Above plus a Linux Docker daemon, reviewed local digest-pinned image, resource controls and working process freezing | Docker required; key or Entra stays on orchestrator host |

**Trusted local is not a sandbox:** candidate tools/validators can reach host
files, credentials, Azure CLI caches and network resources; escaped background
processes are not contained. A prompt asking the agent to stay in its workspace
does not enforce isolation. Use only trusted tasks/code on a suitable disposable
host, or follow [Docker isolation, step by step](docs/ISOLATED_EXECUTION.md).
An isolated configuration fails closed; it never falls back to local execution.

Navigation: [first run](#first-run-one-task-one-deployment) |
[keyless setup](docs/KEYLESS_AUTH.md) |
[Docker path](docs/ISOLATED_EXECUTION.md) |
[task design](docs/TASK_AUTHORING_GUIDE.md) |
[campaign/recovery/publication reference](docs/CAMPAIGNS_AND_PUBLICATION.md).

## First run: one task, one deployment

This **PowerShell 7+** walkthrough uses the supplied text artifact task: read
`input.txt`, create `result.txt` containing `OK`, then run a deterministic
task-owned evaluator. It needs no task-specific packages or Docker. Run the
steps in the **same shell, from the repository root**. For an offline preview,
skip step 3 and stop after step 4; deployment placeholders can remain.

### 1. Install the toolkit

Install [Node.js 20.19+ with npm](https://nodejs.org/en/download) and
[Git](https://git-scm.com/downloads). Installation needs network access;
reporting after installation is offline.

```powershell
git clone https://github.com/samsonlee0907/coding-agent-model-eval-workshop.git
Set-Location coding-agent-model-eval-workshop
node --version
npm --version
git --version
npm ci
npm run build
```

`npm ci` installs the pinned Copilot SDK and its bundled runtime. No Copilot
subscription, separate Copilot CLI, Azure CLI, Azure Developer CLI (`azd`) or
Docker is needed for offline operations. Azure CLI is optional **only for the
`azure-cli` keyless credential** below. An installed standalone Copilot CLI
can override the bundled runtime; see [runtime binding](docs/CAMPAIGNS_AND_PUBLICATION.md#prepare-run-resume).
Contributors can run `npm test` separately; browser checks need an installed
Edge/Chrome or `BENCHMARK_BROWSER_EXECUTABLE`, not Docker or Azure.

### 2. Make a personal, single-cell example

This copies the example and its inputs/evaluators into ignored local storage,
without modifying the repository examples. Use a new `$work` for another run.

```powershell
# onboarding:copy
$work = '.\.benchmark-runs\first-run'
if (Test-Path -LiteralPath $work) { throw 'Choose a new first-run folder.' }
New-Item -ItemType Directory -Path '.\.benchmark-runs' -Force | Out-Null
Copy-Item -LiteralPath '.\examples\custom-campaign' -Destination $work -Recurse
$spec = Get-Content -LiteralPath "$work\campaign.json" -Raw | ConvertFrom-Json
$task = Get-Content -LiteralPath "$work\text-task.json" -Raw | ConvertFrom-Json
$deployment = 'REPLACE_WITH_YOUR_RESPONSES_DEPLOYMENT'
$spec.id = 'first-run-v1'
$spec.tasks = @($spec.tasks[0])
$spec.candidates = @($spec.candidates[0])
$spec.candidates[0].candidate.model = $deployment
$spec.bounds.maxRequests = 10
$spec.bounds.maxReservedTokens = 100000
$spec.bounds.maxReservationUsd = 2
```

This is one task, one candidate, one repeat. Review the copied prompts and
checks. Per-attempt limits are 10 physical requests, 100,000 reserved tokens,
5,000 output tokens/request and five minutes. The USD reservation uses a
declared protective rate, **not an invoice or guaranteed spend cap**. Adjust
bounds to your deployment/task before preparing; no automatic retry-until-PASS.

### 3. Choose authentication (skip for offline preview)

Use an **existing** deployment supporting OpenAI-compatible **Responses** and
the requested reasoning setting. Get its exact deployment name and resource
name from the resource administrator/portal, not a model's marketing name.
Replace `$deployment` in step 2 before continuing. Set the canonical **resource
root**, not a project URL or inference path:

```powershell
$env:FOUNDRY_ENDPOINT = 'https://YOUR_RESOURCE.services.ai.azure.com'
```

**Keyless Microsoft Entra (recommended when supported):** install
[Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli-windows),
reopen PowerShell, rerun steps 2-3 if necessary with a fresh folder, and use
your intended tenant/subscription/account:

```powershell
az version
$tenantId = 'REPLACE_WITH_TENANT_UUID'
$subscriptionId = 'REPLACE_WITH_SUBSCRIPTION_UUID'
az login --tenant $tenantId
az account set --subscription $subscriptionId
az account show --query '{tenant:tenantId,subscription:id,user:user.name}' --output json
Remove-Item Env:FOUNDRY_API_KEY -ErrorAction SilentlyContinue
$spec.candidates[0].foundryProvider.auth = [pscustomobject]@{
    mode = 'entra'; credential = 'azure-cli'; tenantId = $tenantId
}
```

Keep that CLI account stable throughout the campaign. Login/context selection
does **not** grant inference permission. The current callback requests
`https://ai.azure.com/.default`, as in the pinned SDK and Microsoft v1 Responses
examples; it does not auto-select arbitrary endpoint audiences. See
[keyless setup, endpoint-specific roles/scope and host identities](docs/KEYLESS_AUTH.md).
Never paste bearer tokens into files, environment variables or reports.

**API-key alternative:** Azure CLI/login is unnecessary. Do not execute both
authentication branches:

```powershell
$env:FOUNDRY_API_KEY = Read-Host 'Enter the resource API key' -MaskInput
$spec.candidates[0].foundryProvider.auth = [pscustomobject]@{ mode = 'key' }
```

`-MaskInput` needs PowerShell 7.1+; use that version rather than echoing a key
in shell history. The key is held only in the current process environment.
Key-disabled resources require Entra. Omitted `auth` means key mode, **not**
automatic keyless discovery.

### 4. Save, check and preview without inference

```powershell
# onboarding:save
$task.contract.candidate = $spec.candidates[0].candidate
$task.contract.foundryProvider = $spec.candidates[0].foundryProvider
$spec | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath "$work\campaign.json" -Encoding utf8
$task | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath "$work\text-task.json" -Encoding utf8
$state = "$work\state"
```

Use PowerShell 7+ for these JSON-writing commands (UTF-8 without a BOM).
Candidate auth lives in campaign JSON; task auth is mirrored for `doctor`.
Campaign commands have no `--auth` override. Set auth/isolation **before**
preparing, because preparation pins configuration and runtime.

```powershell
# onboarding:offline
npm run doctor -- --config "$work\text-task.json"
npm run campaign -- prepare --spec "$work\campaign.json" --directory $state
npm run campaign -- status --directory $state
npm run campaign -- report --directory $state --output "$work\preview-v1" --zip
```

Expected: `doctor` prints JSON local checks; `data-plane-inference` remains
`not-verified`. Preparation creates `$state\prepared.json`; status shows one
`missing` cell and zero attempts. Open `$work\preview-v1\index.html` directly
in a browser, or share `$work\preview-v1.zip`. Missing is not PASS.

After keyless login, an **optional token-only network check** is:

```powershell
npm run doctor -- --config "$work\text-task.json" --acquire-auth
```

It acquires a token without storing/printing it or sending model inference.
In key mode it checks only that a key is present. Even a successful check does
not verify deployment support, inference RBAC, private-network reachability or
quota. Stop on failed checks; use [keyless diagnostics](docs/KEYLESS_AUTH.md#preflight-and-errors).

### 5. Run the task (cost-bearing), then report

**These commands may consume paid Foundry inference.** Proceed only after
reviewing identity, deployment, bounds and the trusted-local warning above.

```powershell
npm run campaign -- run --directory $state --allow-paid
npm run campaign -- status --directory $state
npm run campaign -- report --directory $state --output "$work\completed-v1" --zip
```

The result may be PASS, content FAIL, interrupted or ungraded; none is
guaranteed. Retained evidence includes `$state\journal.ndjson`,
`$state\runs\<attempt-id>\run.json`, `grade.json` and workspace output. These
are sensitive local artifacts. Publish only the reviewed
`completed-v1` folder/ZIP: `index.html`, `evidence.json`,
`selected-results.json/.csv`, `task-types.json/.csv` and `integrity.json`.
Default publication excludes raw prompts, logs and source/output content.

If interrupted, fix the prerequisite and use the same state:

```powershell
npm run campaign -- resume --directory $state --allow-paid
```

Resume is also cost-bearing for not-yet-run cells; it never silently replays
ambiguous dispatch or reruns a completed content FAIL. It can finalize retained
outputs without inference. Choose a new report destination, e.g. `completed-v2`,
after resume: existing folder/ZIP targets are never overwritten.

For macOS/Linux, use [PowerShell 7](https://learn.microsoft.com/powershell/scripting/install/installing-powershell)
to follow the same configuration steps, with native paths; `npm`/`az` commands
are unchanged. In Bash, set the endpoint/key with `export NAME='value'` instead
of `$env:NAME`, use `/` path separators and your platform's
[Azure CLI installer](https://learn.microsoft.com/cli/azure/install-azure-cli).

## Next workflows

To compare more tasks/deployments/repeats, keep both tasks/candidates in the
[custom campaign](examples/custom-campaign/campaign.json), replace deployment
names and review aggregate bounds. No fixed task count or category vocabulary
exists. See [campaign recovery, grading, pricing and publication](docs/CAMPAIGNS_AND_PUBLICATION.md).

For a disposable exploratory coding task after configuring authentication:

```powershell
# Paid inference; trusted-local, not isolated.
npm run quickstart -- --provider openai --model $deployment --wire-api responses --auth entra --credential azure-cli --tenant-id $tenantId --task 'Build a string-reversal CLI, deterministic tests and package.json test/build scripts.' --output '.\.benchmark-runs\exploration-v1'
```

For key auth use `--auth key` and omit identity flags. Quickstart runs
immediately; it has no `--allow-paid` flag. It writes
`exploration-v1\benchmark.local.json`, `workspace` and `artifacts\<run-id>`.
`--source` copies a starter without changing the original. Report it with:

```powershell
$runs = '.\.benchmark-runs\exploration-v1\artifacts'
npm run report:html -- --runs $runs --bundle '.\.benchmark-runs\exploration-v1\report-v1' --zip
# Compatible explicit single-file output:
npm run report:html -- --runs $runs --output '.\.benchmark-runs\exploration-v1\report.html'
```

`bench --config` also executes immediately and defaults to trusted local.
Advanced controlled-run templates and clean baseline instructions are in
[task authoring](docs/TASK_AUTHORING_GUIDE.md#connect-the-task-file-to-a-controlled-config);
never reuse a mutated workspace for another candidate. `portfolio` consumes
saved runs; optional `prices:refresh` fetches official public prices, while
optional `evaluate` sends **paid** judge requests. Neither is needed for the
first report.

## Reading a generated report

The default report is titled **Coding Agent Model Benchmark**. Read it as an
evidence scorecard, not a single winner. Methodology precedes the interactive
task-by-model matrix. Selection is the **latest clean completion, including
content FAILs, not the latest PASS**. Missing, interrupted, evaluator-error
and ungraded cells remain visible. A newer interruption does not erase an
earlier completion. Candidate validation and independent required acceptance
are separate; validation alone is not PASS.

Matched task-type charts require equal graded coverage and recorded
comparability signatures. Sparse results are descriptive, not routing claims.
Inspectors show provenance, approved previews and metadata replay. Missing
metrics are unavailable, not zero. Contract drift suppresses comparable
price rankings. Optional judge scores never override deterministic validation.

Pricing scenarios are **estimates, not invoices**. Recorded estimates retain
their provenance; an explicit `prices:refresh` snapshot is a saved what-if,
not a live offline price feed or a replacement for recorded prices. See
[pricing semantics](docs/CAMPAIGNS_AND_PUBLICATION.md#evidence-pricing-and-publication).

Portable folder/ZIP and explicit HTML exports make no external requests when
opened. Default publication includes allowlisted metadata only; review labels
too. Sources, output previews and active original downloads need an explicit
hash-bound [publication manifest](examples/publication.example.json).
Raw logs, run/check/grade JSON, per-run Markdown, workspaces, patches and full
judge output are sensitive local evidence requiring separate review.

## Task design and compatibility

Use [task authoring](docs/TASK_AUTHORING_GUIDE.md) for public requirements,
probes, a fixed multi-turn plan and the runnable
[in-memory ordering scenario](scenarios/in-memory-ordering-system/task.md).
[`benchmark.example.json`](benchmark.example.json) is an advanced controlled
template, not an already filled first-run configuration.

The provider is a wire shape, not a model brand: `openai` derives
`https://<resource>.openai.azure.com/openai/v1`; `anthropic` derives
`https://<resource>.services.ai.azure.com/anthropic`. Omitted `wireApi` preserves
OpenAI completions; Responses is explicit and deployment-dependent.
See [endpoint and authentication constraints](docs/KEYLESS_AUTH.md#endpoint-and-token-audience).

Tools default to `read`, `edit`, `shell`. Optional
[MCP](https://modelcontextprotocol.io) servers are part of the immutable local
execution contract and are disallowed in isolated mode. Environment secret
placeholders expand only at launch; never store credentials in config files.
Task/dependency/network policy, rounds, runtime and evaluators must match for
strictly comparable runs.

## Acceptance limits

Tests use fake transport/tokens/clocks and deidentified fixtures. Actual
pinned SDK/CLI acceptance used localhost fake inference and offline Edge.
**Live Azure key/Entra/RBAC/deployment/network and real Docker enforcement were
not verified.** The isolation path needs separately authorized live acceptance;
Docker command construction/export/ownership was injected-executor tested.
No command provisions Azure resources or assigns roles.
Bounded media-token admission, PDF/OCR and independent workbook recalculation
are unsupported; see [publication limits](docs/CAMPAIGNS_AND_PUBLICATION.md).
