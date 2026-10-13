# Coding Agent Model Evaluation Toolkit

A local TypeScript/npm toolkit for comparing coding-agent deployments against
user-defined tasks and a recorded execution policy. It drives persistent
GitHub Copilot SDK sessions through existing Microsoft Foundry deployments,
records execution and evaluator evidence, supports resumable campaigns, and
generates portable offline comparison reports.

The toolkit is for engineers, task authors and platform teams evaluating agent
quality, reliability, time and estimated cost. It supports single-task and
multi-task evaluations with arbitrary candidate counts. Tasks, acceptance
checks and optional categories are supplied by the user; no fixed benchmark
dataset or model ranking is bundled.

**GitHub Copilot is still the agent runtime.** The pinned
[`@github/copilot-sdk` 1.0.10-preview.0](https://github.com/github/copilot-sdk/tree/v1.0.10-preview.0)
and selected Copilot CLI manage sessions, coding tools and fixed multi-turn
work. Microsoft Foundry supplies model inference through the SDK's BYOK
provider; this toolkit supplies task policy, accounting, evaluators and reports.
BYOK runs do not require a GitHub Copilot subscription or Copilot login.

**Start with [Running the toolkit smoothly](docs/RUNNING_THE_TOOLKIT.md):**
one systematic path from task choice, keyless identity/capacity and offline
gates to a bounded one-cell run, acceptance inspection and safe report sharing.
It also covers custom suites, report-only use, operator stop points and the
limits learned from real runs.

## Contents

- [Expected outcomes](#expected-outcomes)
- [Prerequisites](#prerequisites)
- [Installation and configuration](#installation-and-configuration)
- [Toolkit commands and usage](#toolkit-commands-and-usage)
- [Reading a generated report](#reading-a-generated-report)
- [Known limitations and troubleshooting](#known-limitations-and-troubleshooting)
- [Supporting documentation](#supporting-documentation)

## Expected outcomes

A completed evaluation retains local evidence and produces a shareable
**Coding Agent Model Benchmark** report. Results may be PASS, content FAIL,
missing, interrupted or ungraded; completing a workflow does not guarantee
that a candidate meets the task's acceptance criteria.

| Output | Purpose and expected artifacts |
|---|---|
| Prepared campaign and execution history | Immutable task, candidate, evaluator and runtime bindings in `prepared.json`; append-safe attempt history in `journal.ndjson` |
| Per-attempt local evidence | `runs\<attempt-id>\run.json`, `grade.json` and retained workspace output; sensitive evidence, not a publication bundle |
| Portable report folder and optional ZIP | Offline `index.html`, `evidence.json`, `selected-results.json/.csv`, `task-types.json/.csv` and `integrity.json` |
| Comparison views | Task-by-model matrix, provenance, metadata replay and data-derived findings; comparable task-type charts where coverage permits |
| Additional saved-run outputs | Optional Markdown portfolio, official-price what-if snapshot and independent LLM-judge evaluation |

Default publication includes reviewed metadata only, not raw prompts, logs,
source or output content. Content previews require an explicit hash-bound
publication manifest. Reports open directly in a browser without a server,
CDN or network access. See [report interpretation](#reading-a-generated-report)
for selection, comparability and pricing semantics.

## Prerequisites

For installation and CLI use, install **Node.js 20.19+ with npm** and **Git**.
Network access is required to clone the repository and install dependencies.
The walkthrough uses **PowerShell 7+**; its masked API-key prompt requires
7.1+. A generated offline report needs only a browser.

Additional requirements depend on the operation:

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

**Docker is optional**, not a global prerequisite. Azure CLI is required only
for the `azure-cli` keyless credential; managed/workload identities require
their own configured host. Azure Developer CLI (`azd`), a Copilot subscription
and a standalone Copilot CLI are not required.

## Installation and configuration

This repository installs and runs as a **local toolkit**, not a deployed cloud
service. It does not provision Foundry resources, deploy models, configure
Azure hosts or assign roles. Live evaluation uses an existing supported
deployment and an authorized identity or API key. Docker worker setup and
supported-host identity prerequisites are documented in the
[isolation](docs/ISOLATED_EXECUTION.md) and
[keyless authentication](docs/KEYLESS_AUTH.md#managed-and-workload-identities-on-configured-hosts)
guides.

The following setup prepares the supplied text task: read `input.txt`, create
`result.txt` containing `OK`, then run a deterministic task-owned evaluator.
It uses one task, one deployment and one repeat, with no task-specific packages.
Continue through [first-run usage](#first-run-one-task-one-deployment) to preview
or execute it. Keep all steps in the **same PowerShell shell**, from the
repository root after cloning. For an offline-only preview, skip authentication;
deployment placeholders can remain.

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

### 2. Prepare a first-run configuration

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
Responses output limits include reasoning tokens, not just visible text or
files. These example ceilings are protective limits, not evidence that every
task can finish within them. See
[bounded terminal-failure diagnosis](docs/KEYLESS_AUTH.md#bounded-terminal-failure-diagnosis)
before interpreting an interruption or changing the allowance.
The copied pacing limits (30 RPM / 100,000 TPM) are local examples, **not**
discovered deployment capacity. Before paid execution, obtain the actual
deployment's RPM/TPM and approved share of it, then configure pacing below.

### 3. Configure Foundry authentication

Skip this step for an offline-only preview.

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
$account = az account show --subscription $subscriptionId --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'The intended subscription is not available in the CLI login.' }
if ($account.tenantId -ne $tenantId) { throw 'The selected subscription does not belong to the intended tenant.' }
Remove-Item Env:FOUNDRY_API_KEY -ErrorAction SilentlyContinue
$spec.candidates[0].foundryProvider.auth = [pscustomobject]@{
    mode = 'entra'; credential = 'azure-cli'; subscriptionId = $subscriptionId
}
```

The toolkit scopes each CLI token request to this subscription's cached
account/tenant without changing the shared `az` default subscription.
Azure CLI token acquisition accepts **either** `subscriptionId` **or**
`tenantId`, not both. This recipe deliberately selects the subscription and
checks its tenant during setup; it does not store a separate expected-tenant
restriction. For explicit tenant-only requests, replace `subscriptionId` with
`tenantId`, understanding that the current default CLI account supplies the
principal. Invalid both-ID configurations fail before token/inference acquisition;
the toolkit never silently discards an intended selector. Keep the CLI login
stable throughout the campaign.
Login/context selection
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

#### Check deployment capacity before paid execution

Ask the resource administrator for the **specific deployment's** current
RPM/TPM, model/SKU/region and traffic shared with other callers. Subscription
quota is not the deployment's assigned throughput. The toolkit does not
discover these limits or reserve Azure capacity; `doctor --acquire-auth` does
not check them. Example policies can exceed a small deployment's quota.

For a fresh paid configuration, choose approved local pacing ceilings rather
than leaving example values unchanged:

```powershell
# onboarding:pacing
$observedRpm = [int](Read-Host 'Observed deployment requests/minute limit from administrator or management metadata')
$observedTpm = [int](Read-Host 'Observed deployment tokens/minute limit from administrator or management metadata')
$approvedRpm = [int](Read-Host 'Approved local requests/minute ceiling for this deployment')
$approvedTpm = [int](Read-Host 'Approved local reserved tokens/minute ceiling for this deployment')
if ($observedRpm -lt 1 -or $observedTpm -lt 1 -or $approvedRpm -lt 1 -or $approvedTpm -lt 1 -or $approvedRpm -gt $observedRpm -or $approvedTpm -gt $observedTpm) { throw 'Positive local ceilings within observed deployment limits are required.' }
$spec.candidates[0].foundryProvider | Add-Member -NotePropertyName capacity -NotePropertyValue ([pscustomobject]@{
    source = 'administrator-declared'; observedAt = [DateTime]::UtcNow.ToString('o')
    endpoint = $env:FOUNDRY_ENDPOINT; deployment = $deployment; wireApi = 'responses'
    requestsPerMinute = $observedRpm; tokensPerMinute = $observedTpm
}) -Force
$spec.requestBounds.requestsPerMinute = $approvedRpm
$spec.requestBounds.tokensPerMinute = $approvedTpm
$task | Add-Member -NotePropertyName requestBounds -NotePropertyValue $spec.requestBounds -Force
```

Skip this for offline-only previews. Keep output/total/deadline/USD limits
explicit; this step changes only local pacing. The current admission controller
enforces rolling one-minute limits but allows short bursts and cannot see other
processes' traffic. Azure can throttle within shorter windows even below those
minute totals. See [capacity and cooldown guidance](docs/KEYLESS_AUTH.md#deployment-capacity-and-pacing)
for optional read-only discovery and what these controls cannot guarantee.
Preparation and local preflight reject pacing above the bound observation or
an endpoint/deployment/protocol mismatch. The observation is user supplied,
not live capacity certification. Run the initial request-fit gate below too:
slower pacing cannot make an individually oversized SDK request fit TPM.

### 4. Select the execution mode

The copied example uses **trusted-local execution** by default and requires
no Docker. Review the [host-exposure warning](#prerequisites) before executing
candidate code.

For container isolation or private grading, follow the
[Docker setup guide](docs/ISOLATED_EXECUTION.md) now, before saving or preparing.
It covers Linux daemon/resource/freezer requirements, review of an
offline-capable image, actual repository digest pinning and an optional
no-inference worker probe. Docker Desktop installation alone is not acceptance,
and this toolkit supplies no published or reviewed worker image. Isolation is
configured on each task, not selected by a campaign command-line flag.

### 5. Save the configuration

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

For macOS/Linux, use [PowerShell 7](https://learn.microsoft.com/powershell/scripting/install/installing-powershell)
to follow the same configuration steps, with native paths; `npm`/`az` commands
are unchanged. In Bash, set the endpoint/key with `export NAME='value'` instead
of `$env:NAME`, use `/` path separators and your platform's
[Azure CLI installer](https://learn.microsoft.com/cli/azure/install-azure-cli).

## Toolkit commands and usage

Run npm commands from the repository root. The scripts build the toolkit
before execution. Complete [installation and configuration](#installation-and-configuration)
before using the first-run commands below.

| Command | Purpose | Inference and access |
|---|---|---|
| `npm run doctor -- --config <task.json>` | Check configuration/capacity binding; `--verify-runtime` exercises coding tools, `--verify-request-fit` measures the initial task request locally | No cloud inference; `--acquire-auth` optionally acquires an Entra token; a container coding probe requires separate consent |
| `npm run campaign -- <command> ...` | Prepare, run, status, resume, report or clean up owned workers | Prepare/status/report use saved or local evidence; run/resume require `--allow-paid`; isolated cleanup uses Docker |
| `npm run quickstart -- ...` | Create a disposable workspace with `--bounds`; `--prepare-only` prepares offline | Otherwise paid inference immediately; trusted-local only |
| `npm run bench -- --config <task.json>` | Execute one configured task/session | Paid inference immediately; selected task execution mode |
| `npm run report:html -- --runs <runs> ...` | Export saved runs to HTML or a portable folder/ZIP | Offline; no inference |
| `npm run portfolio -- --runs <runs>` | Generate a candidate-validation Markdown summary, not campaign acceptance | Offline; no inference |
| `npm run prices:refresh -- --runs <runs>` | Save an explicit official-price what-if snapshot | Public pricing-page requests, not model inference |
| `npm run evaluate -- ...` | Attach an optional fixed-rubric judge with explicit `--bounds` | Paid inference immediately; selected key/Entra auth |

Campaign run/resume have a paid-operation gate; `quickstart`, `bench` and
`evaluate` do **not** have an `--allow-paid` gate. Do not treat those commands
as preflight checks.

### First run: one task, one deployment

Use the `$work`, `$spec`, `$task` and `$state` saved in the setup section.
For an offline preview, complete only the first step below.

#### 1. Check, prepare and preview without inference

```powershell
# onboarding:offline
npm run doctor -- --config "$work\text-task.json"
npm run doctor -- --config "$work\text-task.json" --verify-runtime
if ($LASTEXITCODE -ne 0) { throw 'Runtime coding probe failed; do not run inference.' }
npm run doctor -- --config "$work\text-task.json" --verify-request-fit
if ($LASTEXITCODE -ne 0) { throw 'Initial request does not fit or cannot be verified; review capacity/request shape before inference.' }
npm run campaign -- prepare --spec "$work\campaign.json" --directory $state
npm run campaign -- status --directory $state
npm run campaign -- report --directory $state --output "$work\preview-v1" --zip
```

Expected: `doctor` prints JSON local checks; `data-plane-inference` remains
`not-verified`. The separate runtime gate creates and edits **two public
fixture files**, reads/lists inputs, runs immediate/enqueued fixed rounds and
handles a request larger than 192 KiB through the actual selected SDK/CLI
against localhost fake Responses. It validates file content, records executable
version/hash separately from backend version, and cleans its owned temporary
files. It uses neither your task inputs nor real credentials. It is not a
live deployment/RBAC check. Unsupported/missing read/edit tools fail before
model dispatch; shell is not added to repair a read/edit contract.
This gate currently supports explicit OpenAI-compatible Responses only.
For a configured isolated worker use the
[explicit actual-image probe](docs/ISOLATED_EXECUTION.md#4-check-prerequisites-then-test-the-actual-boundary-without-inference).

The distinct `--verify-request-fit` gate uses the actual selected SDK/CLI,
unchanged task prompt/instructions/read-edit filters/effort and production
request shaping against localhost. It prints serialized bytes, conservative
reservation, output ceiling, local TPM and prospective headroom, with hashes
instead of prompt/body/endpoint content. No task tool or validator runs.
It currently covers trusted-local Responses without MCP only; other modes
remain unverified. A positive **initial** fit does not prove later growing
context, live token estimation or shared capacity. Every real request still
faces admission before dispatch. See
[initial request-fit limitations and capacity blockers](docs/KEYLESS_AUTH.md#initial-request-fit-and-capacity-blockers).

Preparation creates `$state\prepared.json`; status shows one
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

#### 2. Run the task and generate a report

**These commands may consume paid Foundry inference.** Proceed only after
reviewing identity, deployment capacity/pacing, bounds and the trusted-local warning above.

```powershell
npm run campaign -- run --directory $state --allow-paid
npm run campaign -- status --directory $state
npm run campaign -- report --directory $state --output "$work\completed-v1" --zip
```

Retained evidence includes `$state\journal.ndjson`,
`$state\runs\<attempt-id>\run.json`, `grade.json` and workspace output. These
are sensitive local artifacts. Publish only the reviewed
`completed-v1` folder/ZIP: `index.html`, `evidence.json`,
`selected-results.json/.csv`, `task-types.json/.csv` and `integrity.json`.
Default publication excludes raw prompts, logs and source/output content.

Treat this one-cell run as the **bounded live gate before scale**: inspect
clean execution completion, the requested file, required acceptance grade and
physical request/unknown-spend accounting. A fake-runtime pass does not prove
live transport or model quality. Do not scale an interrupted or ungraded gate;
retain its diagnostics and prepare a new cohort if immutable policy changes.
A clean content FAIL remains a completed result, never an excuse to retry until PASS.

#### 3. Resume an interrupted campaign

Inspect retained checkpoints and all pending cells before approving resume.
If the prerequisite can be fixed without changing immutable source/runtime,
task or policy bindings, eligible unfinished work can use the same state:

```powershell
npm run campaign -- resume --directory $state --allow-paid
```

**Resume is not grading-only:** it is also cost-bearing for not-yet-run cells.
Do not resume an old multi-cell record just to obtain a missing grade.
It never silently replays
ambiguous dispatch or reruns a completed content FAIL. It can finalize retained
outputs without inference. Choose a new report destination, e.g. `completed-v2`,
after resume: existing folder/ZIP targets are never overwritten.
Changed source/runtime/profile requires a new declared cohort, not hidden
rebinding of prepared state. See the [operator stop policy](docs/RUNNING_THE_TOOLKIT.md#operator-admission-and-stop-policy);
the multi-cell runner does not automatically stop on every unsafe interruption
or evaluator ERROR.

### Multi-task campaigns

To compare more tasks/deployments/repeats, keep both tasks/candidates in the
[custom campaign](examples/custom-campaign/campaign.json), replace deployment
names and review aggregate bounds. No fixed task count or category vocabulary
exists. See [campaign recovery, grading, pricing and publication](docs/CAMPAIGNS_AND_PUBLICATION.md).

Use `npm run campaign -- --help` for the implemented command forms.
Preparation binds inputs, prompts, rounds, evaluators and runtime; changes
require a new campaign. Resume the existing state for eligible unfinished
work, not to select a newer PASS or bypass ambiguous dispatch.

### Exploratory quickstart and saved-run reports

For a disposable exploratory task, review
[`examples/request-bounds.example.json`](examples/request-bounds.example.json)
and prepare without inference:

```powershell
npm run quickstart -- --provider openai --model $deployment --wire-api responses --auth entra --credential azure-cli --subscription-id $subscriptionId --bounds '.\examples\request-bounds.example.json' --prepare-only --task 'Build a string-reversal CLI, deterministic tests and package.json test/build scripts.' --output '.\.benchmark-runs\exploration-v1'
npm run doctor -- --config '.\.benchmark-runs\exploration-v1\benchmark.local.json' --verify-runtime
# Paid inference; trusted-local, not isolated. Run only after the gate passes:
npm run bench -- --config '.\.benchmark-runs\exploration-v1\benchmark.local.json'
```

For key auth use `--auth key` and omit identity flags. Without `--prepare-only`,
quickstart runs immediately; it has no `--allow-paid` flag. The CLI requires
`--bounds` in either mode and writes
`exploration-v1\benchmark.local.json`, `workspace` and `artifacts\<run-id>`.
`--source` copies a starter without changing the original. Report it with:

```powershell
$runs = '.\.benchmark-runs\exploration-v1\artifacts'
npm run report:html -- --runs $runs --bundle '.\.benchmark-runs\exploration-v1\report-v1' --zip
# Compatible explicit single-file output:
npm run report:html -- --runs $runs --output '.\.benchmark-runs\exploration-v1\report.html'
```

### Controlled tasks and optional analysis

`bench --config` executes immediately and defaults to trusted local unless
the task config specifies isolation.
Advanced controlled-run templates and clean baseline instructions are in
[task authoring](docs/TASK_AUTHORING_GUIDE.md#connect-the-task-file-to-a-controlled-config);
never reuse a mutated workspace for another candidate.

For the saved `$runs` from the quickstart example, optional analysis is:

```powershell
npm run portfolio -- --runs $runs
npm run prices:refresh -- --runs $runs
```

These write `$runs\model-selection-report.md` and
`$runs\pricing-snapshot.json`. The legacy portfolio's `resolved` counts mean
candidate validation passed after clean execution, not that required campaign
grading completed. Use campaign status/report for required grades and missing
cells; an absent required grade is UNGRADED/pending, not an inferred failure.
See [evidence semantics](docs/CAMPAIGNS_AND_PUBLICATION.md#evidence-pricing-and-publication).
Pricing refresh makes public network requests
and is not required for reporting. Optional `evaluate` sends **paid** judge
requests; its [keyless command example](docs/KEYLESS_AUTH.md#cost-bearing-execution)
uses the actual supported flags. Judge scores never replace required
deterministic acceptance checks.

### Task design and supported configuration

Use [task authoring](docs/TASK_AUTHORING_GUIDE.md) for public requirements,
probes, a fixed multi-turn plan and the runnable
[in-memory ordering scenario](scenarios/in-memory-ordering-system/task.md).
[`benchmark.example.json`](benchmark.example.json) is an advanced controlled
template, not an already filled first-run configuration.

Tools default to `read`, `edit`, `shell`. The selected runtime's catalog maps
edit to native `create` plus `edit`, or `apply_patch` when that catalog supplies
patch editing. Requested capabilities and actual session/wire tools are checked
before inference; neither shell widening nor a blind CLI downgrade is a repair.
Native line patches may retain/add a terminal newline. For byte-exact UTF-8
tasks, explicitly declare `execution.exactContentEdits: true` with `edit`;
this adds a bounded workspace-relative SDK custom writer, not shell.
See [exact editing and its separate two-phase control](docs/TASK_AUTHORING_GUIDE.md#exact-utf-8-editing-without-shell).
The runtime probe reports whether it checked exact two-byte output or only
newline-terminated edits; use the declared exact mode and a new cohort when
your requirements need it.
Optional
[MCP](https://modelcontextprotocol.io) servers are part of the immutable local
execution contract and are disallowed in isolated mode. Environment secret
placeholders expand only at launch; never store credentials in config files.
Task/dependency/network policy, rounds, runtime and evaluators must match for
strictly comparable runs.

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
too. Sources, output previews and active original Open/save links need an explicit
hash-bound [publication manifest](examples/publication.example.json).
Raw logs, run/check/grade JSON, per-run Markdown, workspaces, patches and full
judge output are sensitive local evidence requiring separate review.
Approved originals open separately and can be saved by the browser; offline
`file://` download behavior is browser-dependent and is not guaranteed.

## Known limitations and troubleshooting

### Supported endpoints and execution boundaries

The provider is a wire shape, not a model brand: `openai` derives
`https://<resource>.openai.azure.com/openai/v1`; `anthropic` derives
`https://<resource>.services.ai.azure.com/anthropic`. Omitted `wireApi` preserves
OpenAI completions; Responses is explicit and deployment-dependent.
See [endpoint and authentication constraints](docs/KEYLESS_AUTH.md#endpoint-and-token-audience).

Entra authentication requests the fixed `https://ai.azure.com/.default`
scope; other audiences and automatic credential fallback are unsupported.
Azure CLI login/token acquisition does not grant or verify data-plane
inference permission. Managed/workload identities work only on configured
supported hosts. Trusted-local execution does not isolate credentials or
processes; isolated execution requires the documented Linux worker boundary.

### Verification and publication limits

Tests use fake transport/tokens/clocks and deidentified fixtures. Actual
pinned SDK/CLI integration checks use localhost fake inference and offline
browser checks, including real file creation and multi-round editing.
The relay handles SSE event boundaries, split UTF-8 and protocol-specific
completion, cancels disconnected downstream requests and retains safe phase/status/
byte diagnostics. These reproduced relay fixes do **not** establish the root
cause of older upstream interruptions whose saved evidence lacks that detail.

**Live Azure key/Entra/RBAC/deployment/network and real Docker enforcement were
not verified.** Docker command construction, export and ownership are tested
with injected executors; actual host/container enforcement needs separate
acceptance. No command provisions Azure resources or assigns roles.
Bounded media-token admission, PDF/OCR and independent workbook recalculation
are unsupported; see [publication limits](docs/CAMPAIGNS_AND_PUBLICATION.md).

### Troubleshooting

Start with `doctor --config` and inspect the recorded stage/dispatch status
before attempting another paid run. A successful local check or token
acquisition still leaves `data-plane-inference: not-verified`.

| Symptom | Recommended check or action |
|---|---|
| Configuration or endpoint check fails | Replace example placeholders; use the canonical resource root, exact deployment name and supported provider/protocol |
| Entra credential acquisition fails | Check Azure CLI installation, selected account/tenant and login, or configured host identity; see [keyless diagnostics](docs/KEYLESS_AUTH.md#preflight-and-errors) |
| AADSTS90072/AADSTS50020 | Account/tenant mismatch during credential acquisition, not inference RBAC; verify explicit tenant/subscription and login without changing shared defaults |
| Azure CLI selector/option conflict | Choose only one of `tenantId`/`subscriptionId` or `--tenant-id`/`--subscription-id`; both are rejected before acquisition, not silently ignored |
| Unknown/disabled coding tool | Run `doctor --verify-runtime`; inspect selected executable/hash, backend and resolved filters. Do not add shell or remove the allowlist |
| Quickstart/judge asks for `--bounds` | Review the supplied request policy file; this public CLI requirement preserves request/token/output/pacing/deadline limits |
| Capacity observation/pacing mismatch | Bind the intended endpoint/deployment/wire and approved RPM/TPM before preparing; observation is not live headroom or a quota change |
| Initial conservative reservation exceeds TPM | Inspect `doctor --verify-request-fit` bytes/reservation/headroom. Slower pacing does not shrink SDK context/tools. Use sufficient existing capacity or a separately reviewed supported profile, never an optimistic tokenizer or inflated TPM |
| Native patch succeeds but exact text check fails | Patch tools may add/preserve a newline. Declare `execution.exactContentEdits` and verify actual bytes before a new cohort; do not relax the check or add shell |
| Inference returns 401/403 | Confirm token audience, deployment auth support, endpoint-specific inference role and network access; management roles alone are insufficient |
| HTTP 200 with `provider-terminal` failure | Inspect the first bridge diagnostic's categorical event/status/reason/error code and usage; incomplete is not success or retryable rejection |
| `provider_output_limit` | Confirm retained `max_output_tokens` terminal evidence; reasoning shares the output allowance. Review finite output/total budgets explicitly in a new cohort, not an automatic replay |
| `provider_rate_limit` after HTTP 200 | Provider reported `rate_limit_exceeded` after dispatch. Review deployment RPM/TPM, shared traffic and cooldown; usage may be unknown. This is not a certified rejected HTTP 429 and cannot be replayed automatically |
| Inference returns 404/429 | Check resource/deployment/protocol for 404; check quota and pacing diagnostics for 429, without treating permanent quota as transient |
| Docker/image or worker probe fails | Review Linux daemon, approved local digest, resource controls and freezing; follow [isolation checks](docs/ISOLATED_EXECUTION.md#4-check-prerequisites-then-test-the-actual-boundary-without-inference), never disable isolation as a fallback |
| Prepared configuration/runtime no longer matches | Prepare a new immutable campaign; do not edit state to bypass provenance checks |
| A campaign is interrupted or dispatch is ambiguous | Inspect status and retained evidence; use [recovery rules](docs/CAMPAIGNS_AND_PUBLICATION.md#prepare-run-resume), not an unconditional rerun |
| Report destination already exists | Choose a new versioned folder/ZIP target; publication does not overwrite a previous report |
| Report contains missing/ungraded cells or unavailable metrics | Inspect task coverage and evaluator evidence; absence is not PASS or zero, and sparse data does not justify routing claims |

## Supporting documentation

| Reference | Contents |
|---|---|
| [Running the toolkit smoothly](docs/RUNNING_THE_TOOLKIT.md) | Ordered first-run/operator workflow, public/custom task paths, offline reporting, acceptance and stop rules, accounting and safe sharing |
| [Keyless authentication](docs/KEYLESS_AUTH.md) | Azure CLI onboarding, endpoint roles/audience, token-only preflight, managed/workload identities and refresh |
| [Docker isolation](docs/ISOLATED_EXECUTION.md) | Optional Linux worker setup, image review/digest pinning, feasibility probe and isolated run/report flow |
| [Campaigns and publication](docs/CAMPAIGNS_AND_PUBLICATION.md) | Immutable preparation, bounds, recovery, owned cleanup, evaluators, comparability, pricing and publication policy |
| [Task authoring](docs/TASK_AUTHORING_GUIDE.md) | Task requirements, input baselines, deterministic checks, fixed multi-turn plans and configuration examples |
| [Custom campaign example](examples/custom-campaign/campaign.json) | Runnable text/JSON tasks with task-owned evaluators and replaceable deployments |
| [Publication manifest example](examples/publication.example.json) | Explicit approval of hash-bound source/output previews |
| [In-memory ordering scenario](scenarios/in-memory-ordering-system/task.md) | A more detailed exploratory/controlled coding task |
