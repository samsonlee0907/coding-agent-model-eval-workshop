# Coding Agent Model Evaluation Toolkit

A local TypeScript/npm toolkit that runs coding tasks through the
[GitHub Copilot SDK](https://github.com/github/copilot-sdk/tree/v1.0.10-preview.0)
using your existing Microsoft Foundry deployments, then generates an offline
**Coding Agent Model Benchmark** report. Bring your own tasks and deployments;
no fixed dataset, model ranking or Copilot subscription is required.

**First run:** try the same one-line task with one OpenAI deployment and one
Anthropic deployment below. You get two disposable workspaces, local execution
evidence and a shareable HTML report/ZIP. For independent acceptance checks,
custom suites or recovery, use [Running the toolkit smoothly](docs/RUNNING_THE_TOOLKIT.md).

## Prerequisites

- **Node.js 20.19+ with npm**, **Git**, and **PowerShell 7.1+** for these commands
  and masked key entry. Installation needs network access.
- **Existing Foundry deployments:** one supporting OpenAI Responses, one
  supporting Anthropic Messages. Confirm exact deployment names, supported
  reasoning settings, endpoint reachability and approved RPM/TPM with their
  administrator; subscription quota is not deployment capacity.
- **Authorized authentication for each resource.** These examples use
  already-enabled resource API keys, not direct OpenAI/Anthropic account keys.
  If keys are disabled or unsupported, stop and use the explicit
  [Entra setup](docs/KEYLESS_AUTH.md#local-developer-setup); do not enable keys
  or assume one login works for both resources.

Docker is **not needed** here. Quickstart is trusted-local and grants
read/edit/shell: candidate code can access host files, credentials and caches.
Use trusted tasks on a suitable disposable host. For isolation/private grading,
follow the separate [Docker requirements](docs/ISOLATED_EXECUTION.md).

## 1. Install the reviewed version

Use the exact reviewed commit/tag/branch; a fresh clone's default branch may
not yet contain staging changes. Already in that checkout? Skip clone/ref
selection. No command provisions resources or changes Azure defaults.

```powershell
git clone https://github.com/samsonlee0907/coding-agent-model-eval-workshop.git
Set-Location coding-agent-model-eval-workshop
git fetch origin REPLACE_WITH_REVIEWED_REF
if ($LASTEXITCODE -ne 0) { throw 'Reviewed revision unavailable.' }
git switch --detach FETCH_HEAD
if ($LASTEXITCODE -ne 0) { throw 'Checkout failed.' }
npm ci
if ($LASTEXITCODE -ne 0) { throw 'Installation failed.' }
npm run build
if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
```

The lockfile pins SDK **1.0.10-preview.0**; an installed CLI can override its
bundled runtime. See [host/runtime selection](docs/RUNNING_THE_TOOLKIT.md#1-install-and-select-a-public-task).

## 2. Review bounds and choose one simple task

From the repository root, copy a finite policy for **each deployment**:

```powershell
# first-run:setup
$root = '.\.benchmark-runs\first-comparison-v1'
if (Test-Path -LiteralPath $root) { throw 'Choose a new comparison folder.' }
New-Item -ItemType Directory -Path $root | Out-Null
Copy-Item -LiteralPath '.\examples\request-bounds.example.json' -Destination "$root\openai-bounds.json"
Copy-Item -LiteralPath '.\examples\request-bounds.example.json' -Destination "$root\anthropic-bounds.json"
$task = 'Create a dependency-free Node.js sum(a,b) module, deterministic node:test tests including negative numbers, and package.json test/build scripts; make npm test and npm run build pass.'
```

**Edit/review both bounds files before continuing.** The example declares
10 physical requests, 1 MiB/request, 200,000 conservative token reservations,
5,000 inclusive output tokens/request, five minutes, 10 RPM and 200,000 TPM.
These are examples, **not discovered quota or a completion/billing guarantee**.
Set approved deployment shares, output and time limits; track the combined
two-run budget/deadline yourself. Pacing cannot make an oversized request fit,
and initial fit does not guarantee later context fits. Detailed
[capacity](docs/RUNNING_THE_TOOLKIT.md#capacity-is-not-the-example-policy) and
[bounds guidance](docs/RUNNING_THE_TOOLKIT.md#3-review-finite-policy-and-calibrate-before-preparation)
explain the fields and optional recorded capacity binding.

## 3. Prepare and run each provider

Use **separate PowerShell shells**, both at the reviewed repository root.
The endpoint/key are process environment variables, not saved credentials.
Set the matching pair again before `bench` if you reopen a shell; never reuse
the other provider's resource accidentally. `$task` and `$root` below are
redeclared so each provider block is self-contained after step 2.

### OpenAI example

Use an existing Responses deployment supporting the declared `high` reasoning
setting. This toolkit requires the `.services.ai.azure.com` resource **root**
and derives `.openai.azure.com/openai/v1` internally; do not supply that
derived inference URL or a project path:

```powershell
# first-run:openai
$root = '.\.benchmark-runs\first-comparison-v1'
$task = 'Create a dependency-free Node.js sum(a,b) module, deterministic node:test tests including negative numbers, and package.json test/build scripts; make npm test and npm run build pass.'
$env:FOUNDRY_ENDPOINT = 'https://YOUR_OPENAI_RESOURCE.services.ai.azure.com'
$env:FOUNDRY_API_KEY = Read-Host 'API key for this OpenAI Foundry resource' -MaskInput
npm run quickstart -- --task $task --provider openai --model 'YOUR_OPENAI_DEPLOYMENT' --wire-api responses --auth key --reasoning-effort high --bounds "$root\openai-bounds.json" --prepare-only --output "$root\openai"
if ($LASTEXITCODE -ne 0) { throw 'Preparation failed.' }
npm run doctor -- --config "$root\openai\benchmark.local.json"
if ($LASTEXITCODE -ne 0) { throw 'Local checks failed.' }
npm run doctor -- --config "$root\openai\benchmark.local.json" --verify-runtime
if ($LASTEXITCODE -ne 0) { throw 'Runtime probe failed.' }
npm run doctor -- --config "$root\openai\benchmark.local.json" --verify-request-fit
if ($LASTEXITCODE -ne 0) { throw 'Initial fit blocked or unverified.' }
```

Preparation sends **no inference**. The two optional runtime/fit controls use
localhost fake Responses, not Azure; they do not prove live key validity,
RBAC or model coding quality. See [what each gate proves](docs/RUNNING_THE_TOOLKIT.md#4-run-the-pre-dispatch-gates-in-order).

After reviewing the saved config and obtaining paid-run approval:

```powershell
# PAID inference; no --allow-paid gate on bench.
npm run bench -- --config "$root\openai\benchmark.local.json"
if ($LASTEXITCODE -ne 0) { throw 'Inspect retained evidence before any further paid run.' }
```

Inspect execution and candidate validation before admitting the other run.
An exit 0 is not independent acceptance. Stop on infrastructure/unknown
dispatch/budget errors; never retry until PASS.

### Anthropic example

In its **own shell**, use an existing Claude deployment supporting API-key
authentication and the declared reasoning setting. The toolkit derives
`/anthropic` and the SDK uses Messages; do **not** pass `--wire-api`.

```powershell
# first-run:anthropic
$root = '.\.benchmark-runs\first-comparison-v1'
$task = 'Create a dependency-free Node.js sum(a,b) module, deterministic node:test tests including negative numbers, and package.json test/build scripts; make npm test and npm run build pass.'
$env:FOUNDRY_ENDPOINT = 'https://YOUR_ANTHROPIC_RESOURCE.services.ai.azure.com'
$env:FOUNDRY_API_KEY = Read-Host 'API key for this Anthropic Foundry resource' -MaskInput
npm run quickstart -- --task $task --provider anthropic --model 'YOUR_ANTHROPIC_DEPLOYMENT' --auth key --reasoning-effort high --bounds "$root\anthropic-bounds.json" --prepare-only --output "$root\anthropic"
if ($LASTEXITCODE -ne 0) { throw 'Preparation failed.' }
npm run doctor -- --config "$root\anthropic\benchmark.local.json"
if ($LASTEXITCODE -ne 0) { throw 'Local checks failed.' }
```

**Anthropic runtime/initial-fit doctor controls are currently unsupported:**
do not run the Responses-only probes or switch protocols to get a green gate.
Plain doctor checks local configuration, not live auth/tools/throughput.
Obtain separate deployment/runtime acceptance before authorizing this bounded
smoke; this example is not a claim of live Anthropic or key-auth acceptance.
[Endpoint/auth boundaries](docs/KEYLESS_AUTH.md#endpoint-and-token-audience)
and [safe diagnostics](docs/RUNNING_THE_TOOLKIT.md#diagnose-and-stop-safely)
explain what remains unverified.

```powershell
# PAID inference; run only after the separately reviewed prerequisites.
npm run bench -- --config "$root\anthropic\benchmark.local.json"
if ($LASTEXITCODE -ne 0) { throw 'Inspect retained evidence; do not replay blindly.' }
```

Each provider creates `benchmark.local.json`, `workspace\BENCHMARK_TASK.md`
and a clean local Git baseline. A run retains
`artifacts\<run-id>\run.json`, diagnostics and `report.md`, plus generated
code in `workspace`. Quickstart adds a fixed test/build follow-up and uses
candidate-owned validation; it does **not** create calibrated required
`grade.json`. Use a new workspace/config for another attempt.
Without `--prepare-only`, quickstart itself sends paid inference immediately;
it has no `--allow-paid` flag.

## 4. Generate, open and share the report

After both approved runs, from either shell at the repository root:

```powershell
# first-run:report -- saved evidence only, no auth or inference
$root = '.\.benchmark-runs\first-comparison-v1'
npm run report:html -- --runs $root --bundle "$root\report-v1" --zip
if ($LASTEXITCODE -ne 0) { throw 'Report generation failed.' }
Invoke-Item -LiteralPath "$root\report-v1\index.html"
```

The loader finds both providers' saved runs recursively. A report needs at
least one `run.json`; prepare-only does not generate results. The folder
contains offline HTML, evidence/selected-results/task-types JSON and CSV,
preview metadata and integrity hashes; the companion is `report-v1.zip`.
For just one provider, pass its `artifacts` directory to `--runs`.
An explicit single HTML uses `--output <new-file.html>` instead of `--bundle`
and cannot combine `--zip` or approved previews.

**Interpretation:** execution completion, candidate validation and independent
acceptance are different. This quickstart is exploratory and required
acceptance stays UNGRADED; one task/run per provider is not a ranking.
Independent quickstart baselines can appear as separate task cohorts with
MISSING cross-cells; the shared prompt alone does not make them strictly
comparable. Use a prepared matched campaign for acceptance comparisons.
Unknown usage/billing is not zero, and SDK cost multipliers are not USD. See
[result semantics](docs/RUNNING_THE_TOOLKIT.md#read-results-without-overstating-them)
and [accounting/pricing](docs/RUNNING_THE_TOOLKIT.md#usage-cost-and-what-if-pricing).

Review metadata before sharing **only the report folder/ZIP**, not the parent
workspaces or raw logs. Content previews/original downloads need an explicit
reviewed hash-bound manifest. Use new report/delivery destinations rather than
overwriting history; follow [integrity and safe sharing](docs/RUNNING_THE_TOOLKIT.md#offline-reporting-and-sharing).
The report opens offline in a browser without Node, Azure, a server or CDN.

## More detail

| Next step | Guide |
|---|---|
| Custom JSON/text tasks, fixed rounds, calibrated acceptance or a full suite | [Task choice](docs/RUNNING_THE_TOOLKIT.md#choose-your-path), [authoring](docs/RUNNING_THE_TOOLKIT.md#author-tasks-and-expand-carefully) |
| Keyless, managed/workload identity or capacity questions | [Identity/capacity workflow](docs/RUNNING_THE_TOOLKIT.md#2-bind-identity-endpoint-and-actual-deployment-capacity), [authentication reference](docs/KEYLESS_AUTH.md) |
| Campaign prepare/status/run/resume/report | [Campaign workflow](docs/RUNNING_THE_TOOLKIT.md#5-prepare-preview-then-deliberately-authorize-one-paid-cell), [command map](docs/RUNNING_THE_TOOLKIT.md#command-map) |
| Interruption, missing grade, provider error or Windows grading issue | [Diagnosis](docs/RUNNING_THE_TOOLKIT.md#diagnose-and-stop-safely), [operator stop policy](docs/RUNNING_THE_TOOLKIT.md#operator-admission-and-stop-policy), [resume warning](docs/RUNNING_THE_TOOLKIT.md#resume-is-not-a-grading-only-command) |
| Isolation/private grading | [Docker prerequisites and worker boundary](docs/ISOLATED_EXECUTION.md) |
| Exact-byte editing or a richer benchmark blueprint | [Exact UTF-8 tools](docs/TASK_AUTHORING_GUIDE.md#exact-utf-8-editing-without-shell), [ordering scenario](scenarios/in-memory-ordering-system/task.md) |
| Publication, optional judge/portfolio, pricing and comparability | [Campaign/reference details](docs/CAMPAIGNS_AND_PUBLICATION.md#evidence-pricing-and-publication) |

Official sources: [pinned SDK BYOK](https://github.com/github/copilot-sdk/blob/v1.0.10-preview.0/docs/auth/byok.md),
[Microsoft Responses](https://learn.microsoft.com/azure/foundry/openai/how-to/responses),
[Microsoft Claude Messages/auth](https://learn.microsoft.com/azure/foundry/foundry-models/how-to/use-foundry-models-claude)
and [Anthropic on Foundry](https://platform.claude.com/docs/en/build-with-claude/claude-in-microsoft-foundry).
Run `npm run quickstart -- --help` / `npm run report:html -- --help` for exact
options; see the [operator guide's references and limits](docs/RUNNING_THE_TOOLKIT.md#official-references-and-implementation-truth).
