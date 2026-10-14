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

| Capability | What you get |
|---|---|
| Coding execution | Persistent Copilot SDK/CLI sessions, native coding tools and fixed follow-up rounds; Foundry supplies inference |
| Task-owned acceptance | Required/advisory deterministic checks, reference calibration and immutable resumable campaigns for your tasks |
| Model-based review | Optional fixed-rubric judge scores and citation-checked findings, separate from deterministic grades |
| Usage and price evidence | Known physical-request meters, all-attempt accounting and explicit official-price what-if snapshots |
| Offline publication | Task-by-model matrix, inspectors, metadata replay, JSON/CSV exports and portable folder/ZIP |

## Prerequisites

- **Node.js 20.19+ with npm**, **Git**, and **PowerShell 7+** for these commands.
  Installation needs network access; masked entry for the optional key path
  requires PowerShell 7.1+.
- **Existing Foundry deployments:** one supporting OpenAI Responses, one
  supporting Anthropic Messages. Confirm exact deployment names/model versions,
  supported reasoning settings, endpoint/network access and approved RPM/TPM;
  subscription quota is not deployment capacity.
- **Keyless Microsoft Entra access (preferred):** install
  [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) on the
  orchestrator host, obtain your intended tenant/subscription, and have the
  appropriate **inference permission on each resource**. Login or management
  Contributor alone does not grant inference access. See
  [endpoint-specific roles](docs/KEYLESS_AUTH.md#endpoint-and-token-audience).

Docker is **not needed** here. Quickstart is trusted-local and grants
read/edit/shell: candidate code can access host files, credentials and caches.
Use trusted tasks on a suitable disposable host. For isolation/private grading,
follow the separate [Docker requirements](docs/ISOLATED_EXECUTION.md).

## 1. Install the reviewed version

Use the exact reviewed commit/tag/branch; a fresh clone's default branch may
not yet contain staging changes. Already in that checkout? Skip clone/ref
selection. These installation commands do not provision resources or change
Azure defaults.

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
In each, select the intended CLI account/subscription and set the matching
resource endpoint before `bench`; never inherit the other provider's resource
accidentally. The endpoint is a process variable; saved configs contain the
explicit credential selector, not tokens. `$task` and `$root` are redeclared
below; `$subscriptionId` comes from the common setup.

### Keyless setup (preferred)

After installing Azure CLI/reopening PowerShell, run this setup for the intended
subscription in each provider shell. **If already signed into the intended
account, skip the `az login` line and check the cached mapping.** Sign-in may
require MFA; these are auth/management network operations, not inference.

```powershell
# first-run:auth
$tenantId = 'REPLACE_WITH_EXPECTED_TENANT_UUID'
$subscriptionId = 'REPLACE_WITH_SELECTED_SUBSCRIPTION_UUID'
az version
az login --tenant $tenantId
if ($LASTEXITCODE -ne 0) { throw 'Login failed.' }
$account = az account show --subscription $subscriptionId --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Selected subscription is unavailable.' }
if ($account.tenantId -ne $tenantId) { throw 'Subscription belongs to a different tenant.' }
Remove-Item Env:FOUNDRY_API_KEY -ErrorAction SilentlyContinue
```

The examples pass **subscription only** to `AzureCliCredential`; the expected
tenant is a setup check, not a second stored runtime restriction. Use tenant
**or** subscription, never both with the pinned Azure Identity 4.13.3/CLI
credential. Token requests use the selected cached account without
`az account set` or silent fallback. Keep that login stable; do not print or
paste tokens/headers. The refreshable callback uses fixed
`https://ai.azure.com/.default`. Full
[login/selector guidance](docs/KEYLESS_AUTH.md#local-developer-setup)
explains different tenants/subscriptions and host identities.

**Alternatives:** an already-enabled resource key uses `--auth key` with no
identity flags and `FOUNDRY_API_KEY` supplied only in the host environment.
Managed/workload identity needs a configured host. Use the focused
[key setup](docs/RUNNING_THE_TOOLKIT.md#2-bind-identity-endpoint-and-actual-deployment-capacity)
or [host identity guide](docs/KEYLESS_AUTH.md#managed-and-workload-identities-on-configured-hosts);
do not enable keys or switch methods automatically when keyless fails.

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
npm run quickstart -- --task $task --provider openai --model 'YOUR_OPENAI_DEPLOYMENT' --wire-api responses --auth entra --credential azure-cli --subscription-id $subscriptionId --reasoning-effort high --bounds "$root\openai-bounds.json" --prepare-only --output "$root\openai"
if ($LASTEXITCODE -ne 0) { throw 'Preparation failed.' }
npm run doctor -- --config "$root\openai\benchmark.local.json"
if ($LASTEXITCODE -ne 0) { throw 'Local checks failed.' }
npm run doctor -- --config "$root\openai\benchmark.local.json" --verify-runtime
if ($LASTEXITCODE -ne 0) { throw 'Runtime probe failed.' }
npm run doctor -- --config "$root\openai\benchmark.local.json" --verify-request-fit
if ($LASTEXITCODE -ne 0) { throw 'Initial fit blocked or unverified.' }
# Token-only Azure network operation, not a model request:
npm run doctor -- --config "$root\openai\benchmark.local.json" --acquire-auth
if ($LASTEXITCODE -ne 0) { throw 'Selected authentication failed.' }
```

Preparation sends **no inference**. The two optional runtime/fit controls use
localhost fake Responses, not Azure. The final token-only gate exercises the
selected Entra credential but does **not** certify data-plane RBAC, deployment
availability or coding quality. See [what each gate proves](docs/RUNNING_THE_TOOLKIT.md#4-run-the-pre-dispatch-gates-in-order).

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

In its **own shell**, repeat the common keyless setup for the intended account,
then use an existing Claude deployment supporting Entra and the declared
reasoning setting. The toolkit/SDK support a refreshable bearer provider and
[Microsoft documents Entra Messages authentication](https://learn.microsoft.com/azure/foundry/foundry-models/how-to/use-foundry-models-claude)
with the same scope. The toolkit derives `/anthropic` and the SDK uses
Messages; do **not** pass `--wire-api`.

```powershell
# first-run:anthropic
$root = '.\.benchmark-runs\first-comparison-v1'
$task = 'Create a dependency-free Node.js sum(a,b) module, deterministic node:test tests including negative numbers, and package.json test/build scripts; make npm test and npm run build pass.'
$env:FOUNDRY_ENDPOINT = 'https://YOUR_ANTHROPIC_RESOURCE.services.ai.azure.com'
npm run quickstart -- --task $task --provider anthropic --model 'YOUR_ANTHROPIC_DEPLOYMENT' --auth entra --credential azure-cli --subscription-id $subscriptionId --reasoning-effort high --bounds "$root\anthropic-bounds.json" --prepare-only --output "$root\anthropic"
if ($LASTEXITCODE -ne 0) { throw 'Preparation failed.' }
npm run doctor -- --config "$root\anthropic\benchmark.local.json"
if ($LASTEXITCODE -ne 0) { throw 'Local checks failed.' }
# Token-only Azure network operation, not a model request:
npm run doctor -- --config "$root\anthropic\benchmark.local.json" --acquire-auth
if ($LASTEXITCODE -ne 0) { throw 'Selected authentication failed.' }
```

**Anthropic runtime/initial-fit doctor controls are currently unsupported:**
do not run the Responses-only probes or switch protocols to get a green gate.
Plain doctor checks local configuration, not live auth/tools/throughput.
The separate token gate proves acquisition only. Verify resource inference
permission, model/version/API/reasoning support and local runtime tools
separately before approving the bounded smoke. Supported configuration and
vendor documentation are **not new live Anthropic acceptance**.
Deployments that require adaptive thinking, or a reviewed native input estimate
instead of byte-based admission, can use the
[explicit opt-in profile](docs/CAMPAIGNS_AND_PUBLICATION.md#optional-anthropic-native-count-admission).
It retries bounded read-only count timeouts before inference, never ambiguous
model requests or an entire candidate.
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
See [result semantics](docs/RUNNING_THE_TOOLKIT.md#read-results-without-overstating-them).

Review metadata before sharing **only the report folder/ZIP**, not the parent
workspaces or raw logs. Content previews/original downloads need an explicit
reviewed hash-bound manifest. Use new report/delivery destinations rather than
overwriting history; follow [integrity and safe sharing](docs/RUNNING_THE_TOOLKIT.md#offline-reporting-and-sharing).
The report opens offline in a browser without Node, Azure, a server or CDN.

## How grading works

There are three different questions: did execution finish, did the candidate's
test/build gate pass, and did the delivered artifact satisfy independent public
requirements? Quickstart answers the first two; its candidate-written tests
can miss requirements, so required acceptance remains **UNGRADED**.

For true acceptance, declare a task-owned evaluator in a
[prepared campaign](docs/RUNNING_THE_TOOLKIT.md#5-prepare-preview-then-deliberately-authorize-one-paid-cell).
Required checks determine PASS/content FAIL; advisory failures are WEAK rather
than required failures. Positive, negative and equivalent-valid reference
fixtures calibrate the unchanged policy before execution. The original
`runs\<attempt-id>\grade.json` binds run, output bytes and policy; a separately
graded diagnostic copy does not recover the original grade.

| Evidence | Read it as |
|---|---|
| Required PASS / content FAIL | A completed artifact did/did not meet the declared required checks; retain FAIL, never rerun until PASS |
| Evaluator ERROR | Check/setup/spawn/timeout infrastructure uncertainty, not a model content verdict |
| UNGRADED / MISSING | Required evidence absent / no recorded cell attempt; neither means zero cost or PASS |
| Interrupted execution | Fixed work/round plan incomplete, even if a file or visible validator looks green |

CLI exit 0 or a completed journal job is not required PASS. Default selection
is the latest clean completion **including FAIL**, not the latest PASS.
Match full task/input/round/tool/runtime/reasoning/output/evaluator profiles
before comparisons; provider/API differences and sparse samples matter.
See [acceptance/calibration design](docs/TASK_AUTHORING_GUIDE.md#versioned-evidence-and-evaluator-design)
and [result interpretation](docs/RUNNING_THE_TOOLKIT.md#read-results-without-overstating-them).

## Usage and optional pricing

Known physical terminal meters describe usage; SDK model-usage records are not
request counts. Reasoning is already part of output, and cache subdivisions
must not be added twice. **SDK cost multipliers are not USD.** Protective
byte/token/USD reservations are admission declarations, not invoices or
guaranteed billing caps. Compare selected-run versus **all-attempt** cost and
coverage separately; missing meters or billing remain unknown, not $0.

An optional refresh fetches public **official published pricing**, not model
inference: Azure OpenAI's pricing page and Claude API pricing, with Foundry
Claude billing/cache references. It saves `$root\pricing-snapshot.json`.
This is a versioned **what-if estimate**, not negotiated billing, a rewrite of
recorded campaign prices or real-time offline HTML.

```powershell
# Optional public pricing network only; preserve an existing snapshot first.
npm run prices:refresh -- --runs $root
if ($LASTEXITCODE -ne 0) { throw 'Pricing refresh failed; retain the earlier report.' }
# Offline: explicitly attach that saved snapshot to a new report.
npm run report:html -- --runs $root --pricing "$root\pricing-snapshot.json" --bundle "$root\report-priced-v1" --zip
```

Custom deployment names may need an exact `--pricing-model recorded=Official Label`
mapping; `--region` filters published pricing-page regions. Unresolved labels,
regions or meters remain unavailable. Claude retains 5-minute/1-hour cache
scenarios and needs explicit labeled input-accounting assumptions; an invoice
or automatic cheapest-price default is not inferred. Report HTML shows attached
what-if scenarios; normalized exports keep recorded estimates unchanged.
See [pricing semantics and sources](docs/RUNNING_THE_TOOLKIT.md#usage-cost-and-what-if-pricing).

## Optional model-based rubric review

After deterministic validation, a separately authorized model judge can review
the retained final source, manifest/integrity evidence, bounded diffs,
validation and available run-level conformance evidence. The current fixed
`benchmark-judge-v3` rubric has **seven integer dimensions, 1-5**:
correctness, test adequacy, API design, reproducibility, code quality,
requirement coverage and maintainability. It records low/medium/high evidence
confidence, reviewed files and file/line findings with citation checks.
There are no custom dimension/weight flags.

`evaluate` is **paid inference immediately**, with its own approved judge,
endpoint/identity, request/output/context/deadline bounds and authorization.
It has no coding tools, but the reviewed content is still sent to a model:
do not submit unapproved private code. Missing source limits evidence; no
invented review can substitute for it. The judge does not import external
campaign `grade.json` automatically or replace required deterministic grades.

One optional example, in the OpenAI shell, uses a judge in the **same approved
resource**. First create/review a separate `$root\judge-bounds.json`; its source
review request can be much larger than the coding prompt. Then:

```powershell
# PAID judge, only after separate approval and reviewed bounds.
npm run evaluate -- --runs $root --provider openai --model 'YOUR_APPROVED_JUDGE_DEPLOYMENT' --wire-api responses --auth entra --credential azure-cli --subscription-id $subscriptionId --bounds "$root\judge-bounds.json" --output "$root\judge-review-v1.json"
if ($LASTEXITCODE -ne 0) { throw 'Judge failed; inspect retained accounting, not fabricated scores.' }
# Offline: attach the exact evaluation, optionally pricing too if already saved.
npm run report:html -- --runs $root --evaluation "$root\judge-review-v1.json" --bundle "$root\report-reviewed-v1" --zip
```

The local evaluation JSON contains scores, rationales/findings, limitations
and judge provenance; keep it sensitive. Without `--output`, the CLI writes
`llm-evaluation-<timestamp>.json` in the runs root and run-based reports discover
the latest root-level file. The explicit path above avoids guessing.
Failure produces an accounting artifact with no published scores.
Report HTML includes structured numeric review/coverage, not private judge
narratives or findings. These qualitative scores **never override** deterministic
outcomes or establish a broad model ranking. See the
[rubric and evidence reference](docs/TASK_AUTHORING_GUIDE.md#quality-evidence-and-scorecards).

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
[refreshable Entra callback](https://github.com/github/copilot-sdk/blob/v1.0.10-preview.0/docs/setup/azure-managed-identity.md),
[Azure CLI login](https://learn.microsoft.com/cli/azure/authenticate-azure-cli-interactively),
[Microsoft Responses](https://learn.microsoft.com/azure/foundry/openai/how-to/responses),
[Microsoft Claude Messages/auth](https://learn.microsoft.com/azure/foundry/foundry-models/how-to/use-foundry-models-claude)
and [Anthropic on Foundry](https://platform.claude.com/docs/en/build-with-claude/claude-in-microsoft-foundry).
Run `npm run quickstart -- --help` / `npm run report:html -- --help` for exact
options; see the [operator guide's references and limits](docs/RUNNING_THE_TOOLKIT.md#official-references-and-implementation-truth).
