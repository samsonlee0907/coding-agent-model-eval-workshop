# Coding Agent Model Evaluation Workshop

A TypeScript/npm toolkit for comparing coding-agent runs on the same task and
execution policy. It drives persistent
[GitHub Copilot SDK](https://github.com/github/copilot-sdk/tree/v1.0.10-preview.0)
sessions through existing Microsoft Foundry deployments, records evidence,
runs deterministic checks, and produces an offline **Coding Agent Model
Benchmark** report.

This staging README keeps the original main-branch journey and adds two
incremental capabilities: Microsoft Entra (keyless) authentication and a
copyable one-GPT/one-Claude walkthrough. The current `main` branch at
`010fc0799332af6ae7e425cb35fdd96ac978287c` does not contain every staging flag
used below. Clone the named staging branch until these changes are released.

## Start here

### 1. Install

| Prerequisite | Required for | Notes |
|---|---|---|
| Node.js 20.19+ with npm | Installation and every toolkit command | Check `node --version` and `npm --version`. |
| Git | Clone and local task baselines | Make it available on `PATH`. |
| Azure CLI | Keyless local runs | Install it on the orchestrator host; key authentication does not need it. |
| Existing Foundry deployments | Live runs | This toolkit does not provision models, change quota, or assign IAM. |
| Network access | Install, sign-in, live runs, optional pricing refresh | Report/portfolio generation is local. |
| Docker | Optional isolation/private grading only | Not needed for the trusted-local first run below. |

`npm ci` installs the pinned SDK and its bundled Copilot CLI runtime. A
standalone Copilot CLI and GitHub Copilot subscription are not required.
Trusted-local runs grant candidate code `read`, `edit`, and `shell` access on
the host, including access to host files, network, credentials, and caches.
Use trusted tasks on a suitable disposable machine; see
[isolated execution](docs/ISOLATED_EXECUTION.md) before running untrusted code.

<details open>
<summary><strong>PowerShell 7+ / Windows</strong></summary>

```powershell
# first-run:install-powershell
git clone --branch samsonlee0907-staging-benchmark-revamp --single-branch https://github.com/samsonlee0907/coding-agent-model-eval-workshop.git
Set-Location coding-agent-model-eval-workshop
node --version
npm --version
git --version
npm ci
if ($LASTEXITCODE -ne 0) { throw 'Installation failed.' }
npm run build
if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
```

</details>

<details>
<summary><strong>Bash / macOS or Linux</strong></summary>

Run these in Bash. From zsh, enter `bash` first or translate only the ordinary
shell variable syntax; the toolkit commands themselves are identical.

```bash
# first-run:install-bash
git clone --branch samsonlee0907-staging-benchmark-revamp --single-branch https://github.com/samsonlee0907/coding-agent-model-eval-workshop.git
cd coding-agent-model-eval-workshop
node --version
npm --version
git --version
npm ci
npm run build
```

On macOS with Homebrew, `brew install azure-cli` installs Azure CLI. If a new
Homebrew install is not yet on `PATH`, run `eval "$(brew shellenv)"`. Linux
users should use Microsoft's
[distribution-specific Azure CLI installer](https://learn.microsoft.com/cli/azure/install-azure-cli-linux),
then open a new shell and run `az version`.

</details>

### 2. Configure Foundry

Obtain the resource root and exact deployment name for one OpenAI Responses
deployment and one Anthropic Messages deployment. `FOUNDRY_ENDPOINT` is the
resource root only—no project path, `/openai/v1`, `/anthropic`, query, or
fragment:

| `--provider` | Toolkit-derived inference base | First-run protocol |
|---|---|---|
| `openai` | `https://<resource>.openai.azure.com/openai/v1` | Explicit `--wire-api responses` |
| `anthropic` | `https://<resource>.services.ai.azure.com/anthropic` | Messages; do not pass `--wire-api` |

The runner records an endpoint fingerprint, not the endpoint, key, or token.
Confirm the exact model/version, reasoning support, inference permission,
network access, RPM, and TPM with the resource administrator. Subscription
quota is not deployment capacity.

#### Keyless setup (preferred)

This local keyless path uses Azure CLI plus Microsoft Entra ID.

Microsoft documents interactive `az login` on Windows, macOS, and Linux,
including MFA and browser/device-code flows. The toolkit passes the
subscription selector to `AzureCliCredential` at runtime; it does **not** run
`az account set`, silently choose another account, or fall back to a key.
Use subscription **or** tenant as the stored selector, never both. The recipe
below checks the expected tenant during setup and stores subscription only.

<details open>
<summary><strong>PowerShell 7+ / Windows</strong></summary>

```powershell
# first-run:auth-powershell
$tenantId = 'REPLACE_WITH_EXPECTED_TENANT_UUID'
$subscriptionId = 'REPLACE_WITH_SELECTED_SUBSCRIPTION_UUID'
az version
az login --tenant $tenantId
if ($LASTEXITCODE -ne 0) { throw 'Azure login failed.' }
$account = az account show --subscription $subscriptionId --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Selected subscription is unavailable.' }
if ($account.tenantId -ne $tenantId) { throw 'Subscription belongs to a different tenant.' }
Remove-Item Env:FOUNDRY_API_KEY -ErrorAction SilentlyContinue
```

</details>

<details>
<summary><strong>Bash / macOS or Linux</strong></summary>

```bash
# first-run:auth-bash
tenant_id='REPLACE_WITH_EXPECTED_TENANT_UUID'
subscription_id='REPLACE_WITH_SELECTED_SUBSCRIPTION_UUID'
az version
az login --tenant "$tenant_id"
account_tenant="$(az account show --subscription "$subscription_id" --query tenantId --output tsv)"
test "$account_tenant" = "$tenant_id" || { echo 'Subscription belongs to a different tenant.' >&2; exit 1; }
unset FOUNDRY_API_KEY
```

</details>

Your identity needs the endpoint-specific data-plane inference role. Login,
subscription access, or management Contributor alone is not proof of inference
permission. The toolkit requests refreshable tokens for
`https://ai.azure.com/.default`; see the detailed
[keyless authentication boundary](docs/KEYLESS_AUTH.md).

#### Existing key option

Key behavior remains backward compatible. Use `--auth key`, omit identity
flags, and keep the key only in the current host shell:

```powershell
# PowerShell 7.1+
$env:FOUNDRY_API_KEY = Read-Host 'Foundry resource key' -MaskInput
```

```bash
# Bash / macOS or Linux
read -r -s -p 'Foundry resource key: ' FOUNDRY_API_KEY
printf '\n'
export FOUNDRY_API_KEY
```

Do not execute both auth paths or store credentials in config files.

#### Create finite model-specific bounds

Staging requires `--bounds` for immediate quickstart execution. Do not use the
repository's 200k TPM example unchanged for a deployment with less capacity.
Enter an approved share of each deployment's observed RPM/TPM. The commands
below create a new shared report root, cap each run at 20 physical inference
requests, 1 MiB/request, 8,192 output tokens/request, 20 minutes, and a total
reservation of `20 x approved TPM`. These are local safeguards, not a USD cap,
invoice estimate, or guarantee that every request will fit.

<details open>
<summary><strong>PowerShell 7+ / Windows</strong></summary>

```powershell
# first-run:bounds-powershell
$root = '.\.benchmark-runs\first-comparison-v1'
if (Test-Path -LiteralPath $root) { throw 'Choose a new comparison folder.' }
New-Item -ItemType Directory -Path $root | Out-Null
$gptRpm = [int](Read-Host 'Approved GPT RPM share')
$gptTpm = [int](Read-Host 'Approved GPT TPM share')
$claudeRpm = [int](Read-Host 'Approved Claude RPM share')
$claudeTpm = [int](Read-Host 'Approved Claude TPM share')
if (@($gptRpm,$gptTpm,$claudeRpm,$claudeTpm) | Where-Object { $_ -lt 1 }) { throw 'Positive finite limits are required.' }
@{maxRequests=20;maxRequestBytes=1048576;maxTokens=20*$gptTpm;maxOutputTokens=8192;deadlineMs=1200000;requestsPerMinute=$gptRpm;tokensPerMinute=$gptTpm} |
  ConvertTo-Json | Set-Content -LiteralPath "$root\gpt-bounds.json" -Encoding utf8
@{maxRequests=20;maxRequestBytes=1048576;maxTokens=20*$claudeTpm;maxOutputTokens=8192;deadlineMs=1200000;requestsPerMinute=$claudeRpm;tokensPerMinute=$claudeTpm} |
  ConvertTo-Json | Set-Content -LiteralPath "$root\claude-bounds.json" -Encoding utf8
```

</details>

<details>
<summary><strong>Bash / macOS or Linux</strong></summary>

```bash
# first-run:bounds-bash
root='.benchmark-runs/first-comparison-v1'
test ! -e "$root" || { echo 'Choose a new comparison folder.' >&2; exit 1; }
mkdir -p "$root"
read -r -p 'Approved GPT RPM share: ' gpt_rpm
read -r -p 'Approved GPT TPM share: ' gpt_tpm
read -r -p 'Approved Claude RPM share: ' claude_rpm
read -r -p 'Approved Claude TPM share: ' claude_tpm
test "$gpt_rpm" -gt 0 && test "$gpt_tpm" -gt 0 && test "$claude_rpm" -gt 0 && test "$claude_tpm" -gt 0 ||
  { echo 'Positive finite limits are required.' >&2; exit 1; }
cat >"$root/gpt-bounds.json" <<EOF
{"maxRequests":20,"maxRequestBytes":1048576,"maxTokens":$((20*gpt_tpm)),"maxOutputTokens":8192,"deadlineMs":1200000,"requestsPerMinute":$gpt_rpm,"tokensPerMinute":$gpt_tpm}
EOF
cat >"$root/claude-bounds.json" <<EOF
{"maxRequests":20,"maxRequestBytes":1048576,"maxTokens":$((20*claude_tpm)),"maxOutputTokens":8192,"deadlineMs":1200000,"requestsPerMinute":$claude_rpm,"tokensPerMinute":$claude_tpm}
EOF
```

</details>

Optional deployment-capacity observation, doctor/runtime probes, Anthropic
native token counting, managed/workload identity, and campaign admission are
advanced controls, not prerequisites for reading this flow. See
[Running the toolkit smoothly](docs/RUNNING_THE_TOOLKIT.md) and
[campaign/publication details](docs/CAMPAIGNS_AND_PUBLICATION.md).

### 3. Try one exploratory task

Run the same ordinary task once with GPT and once with Claude, sequentially.
Each command creates a separate disposable local Git baseline and workspace
under the shared `$root`/`$root` folder. It never modifies this repository.
These commands send **paid inference immediately**. Review the bounds,
deployment, endpoint, and auth selector first. Do not retry until PASS: a
completed execution whose validator fails is still retained evidence; an
infrastructure interruption is not a completed run.

The primary Claude path uses Messages and its standard high-effort wire shape.
It does not opt into native token counting. If a reviewed deployment needs
native input admission or adaptive thinking, follow the optional
[Anthropic native-count profile](docs/CAMPAIGNS_AND_PUBLICATION.md#optional-anthropic-native-count-admission)
rather than adding hidden retries.

<details open>
<summary><strong>PowerShell 7+ / Windows — keyless</strong></summary>

```powershell
# first-run:models-powershell
$task = 'Create a dependency-free Node.js module exporting sum(a, b), deterministic node:test coverage for positive, negative, zero, and non-number rejection, and package.json test/build scripts; make npm test and npm run build pass.'
$gptDeployment = 'YOUR_EXISTING_GPT_RESPONSES_DEPLOYMENT'
$claudeDeployment = 'YOUR_EXISTING_CLAUDE_MESSAGES_DEPLOYMENT'

$env:FOUNDRY_ENDPOINT = 'https://YOUR_GPT_RESOURCE.services.ai.azure.com'
npm run quickstart -- --task $task --provider openai --model $gptDeployment --wire-api responses --auth entra --credential azure-cli --subscription-id $subscriptionId --reasoning-effort high --bounds "$root\gpt-bounds.json" --output "$root\gpt"
if ($LASTEXITCODE -ne 0) { throw 'GPT run did not complete; inspect retained evidence and do not replay blindly.' }

$env:FOUNDRY_ENDPOINT = 'https://YOUR_CLAUDE_RESOURCE.services.ai.azure.com'
npm run quickstart -- --task $task --provider anthropic --model $claudeDeployment --auth entra --credential azure-cli --subscription-id $subscriptionId --reasoning-effort high --bounds "$root\claude-bounds.json" --output "$root\claude"
if ($LASTEXITCODE -ne 0) { throw 'Claude run did not complete; inspect retained evidence and do not replay blindly.' }
```

</details>

<details>
<summary><strong>Bash / macOS or Linux — keyless</strong></summary>

```bash
# first-run:models-bash
task='Create a dependency-free Node.js module exporting sum(a, b), deterministic node:test coverage for positive, negative, zero, and non-number rejection, and package.json test/build scripts; make npm test and npm run build pass.'
gpt_deployment='YOUR_EXISTING_GPT_RESPONSES_DEPLOYMENT'
claude_deployment='YOUR_EXISTING_CLAUDE_MESSAGES_DEPLOYMENT'

export FOUNDRY_ENDPOINT='https://YOUR_GPT_RESOURCE.services.ai.azure.com'
npm run quickstart -- --task "$task" --provider openai --model "$gpt_deployment" --wire-api responses --auth entra --credential azure-cli --subscription-id "$subscription_id" --reasoning-effort high --bounds "$root/gpt-bounds.json" --output "$root/gpt"

export FOUNDRY_ENDPOINT='https://YOUR_CLAUDE_RESOURCE.services.ai.azure.com'
npm run quickstart -- --task "$task" --provider anthropic --model "$claude_deployment" --auth entra --credential azure-cli --subscription-id "$subscription_id" --reasoning-effort high --bounds "$root/claude-bounds.json" --output "$root/claude"
```

</details>

For the key alternative, keep the same commands and replace
`--auth entra --credential azure-cli --subscription-id ...` with
`--auth key`. OpenAI must still use `--wire-api responses`; Anthropic must not
use `--wire-api`. `quickstart` adds a fixed follow-up that runs `npm test` and
`npm run build`. Its validator is candidate-owned, so independent required
acceptance remains **UNGRADED**.

### 4. Run a controlled cohort

After the exploratory runs, use controlled copies when you need a pinned
baseline, fixed rounds, task-owned checks, or repeated attempts. Preserve the
main flow: copy [`benchmark.example.json`](benchmark.example.json), replace
every `REPLACE_...` value, use one clean candidate workspace per attempt, and
write every candidate under one artifacts parent. Do not reuse an exploratory
workspace or point `workspacePath` at the source baseline.

<details open>
<summary><strong>PowerShell 7+ / Windows</strong></summary>

```powershell
Copy-Item -LiteralPath '.\benchmark.example.json' -Destination '.\candidate-gpt.json'
Copy-Item -LiteralPath '.\benchmark.example.json' -Destination '.\candidate-claude.json'
git -C 'C:\benchmark-workspaces\candidate-gpt' checkout --detach '<pinned-commit>'
git -C 'C:\benchmark-workspaces\candidate-gpt' clean -fd
npm run bench -- --config '.\candidate-gpt.json'
git -C 'C:\benchmark-workspaces\candidate-claude' checkout --detach '<pinned-commit>'
git -C 'C:\benchmark-workspaces\candidate-claude' clean -fd
npm run bench -- --config '.\candidate-claude.json'
```

</details>

<details>
<summary><strong>Bash / macOS or Linux</strong></summary>

```bash
cp ./benchmark.example.json ./candidate-gpt.json
cp ./benchmark.example.json ./candidate-claude.json
git -C "$HOME/benchmark-workspaces/candidate-gpt" checkout --detach '<pinned-commit>'
git -C "$HOME/benchmark-workspaces/candidate-gpt" clean -fd
npm run bench -- --config ./candidate-gpt.json
git -C "$HOME/benchmark-workspaces/candidate-claude" checkout --detach '<pinned-commit>'
git -C "$HOME/benchmark-workspaces/candidate-claude" clean -fd
npm run bench -- --config ./candidate-claude.json
```

</details>

Keep prompt, baseline, instructions, rounds, tools, network policy, runtime,
reasoning/output settings, validation, and evaluator policy identical where
you claim comparison. For resumable multi-task matrices, calibrated evaluators,
or isolated/private grading, use the optional
[campaign workflow](docs/RUNNING_THE_TOOLKIT.md#5-prepare-preview-then-deliberately-authorize-one-paid-cell).

### 5. Generate decision artifacts

Portfolio and report generation read saved evidence and send no model request.
Pricing refresh is an optional public-network operation against official
pricing pages. Use fresh output names: publication refuses to overwrite a good
report with partial output.

<details open>
<summary><strong>PowerShell 7+ / Windows</strong></summary>

```powershell
# first-run:report-powershell
$runs = $root
npm run portfolio -- --runs $runs
npm run report:html -- --runs $runs --bundle "$root\report-v1" --zip
if ($LASTEXITCODE -ne 0) { throw 'Report generation failed.' }
Invoke-Item -LiteralPath "$root\report-v1\index.html"

# Optional official-price what-if snapshot; not inference or an invoice.
npm run prices:refresh -- --runs $runs
npm run report:html -- --runs $runs --pricing "$root\pricing-snapshot.json" --bundle "$root\report-priced-v1" --zip
# If the snapshot includes Claude, add one reviewed accounting assumption:
# --anthropic-accounting sdk-inclusive   OR   --anthropic-accounting native-uncached
```

</details>

<details>
<summary><strong>Bash / macOS or Linux</strong></summary>

```bash
# first-run:report-bash
runs="$root"
npm run portfolio -- --runs "$runs"
npm run report:html -- --runs "$runs" --bundle "$root/report-v1" --zip
if [ "$(uname -s)" = 'Darwin' ]; then open "$root/report-v1/index.html"; else xdg-open "$root/report-v1/index.html"; fi

# Optional official-price what-if snapshot; not inference or an invoice.
npm run prices:refresh -- --runs "$runs"
npm run report:html -- --runs "$runs" --pricing "$root/pricing-snapshot.json" --bundle "$root/report-priced-v1" --zip
# If the snapshot includes Claude, add one reviewed accounting assumption:
# --anthropic-accounting sdk-inclusive   OR   --anthropic-accounting native-uncached
```

</details>

The shared root is searched recursively, so the GPT and Claude `run.json`
artifacts are both included. The portable folder/ZIP includes offline HTML,
normalized evidence, selected and all-attempt usage JSON/CSV, task-type data,
first-class pricing status/estimates JSON/CSV, the exact attached pricing
snapshot when present, preview metadata, and integrity hashes. The offline
HTML always has a visible pricing section: without a saved snapshot it shows
**UNKNOWN**, the reason, and the explicit refresh/attach action rather than
hiding pricing or displaying zero. A single HTML file uses
`--output <new-file.html>` instead of `--bundle`; it cannot combine with
`--zip` or approved previews.

## Reading a generated report

Read the output as an evidence scorecard, not a universal model ranking.
Execution completion, task validation, and independent acceptance are separate.
A completed run can have validation FAIL or content FAIL. UNGRADED means
required independent evidence was not recorded; MISSING means no cell attempt.
Neither means zero cost or PASS.

The report shows recorded input/output/total tokens, observed agent turns, SDK
usage records, physical inference requests, tool calls, wall time, cache
counters, and separately labeled native-count requests where recorded.
Unknown values stay unknown rather than becoming zero. Reasoning is already
inside output tokens; cache tokens and native-count calls are not added again.
One exploratory task/run per provider is descriptive and does not establish
reliability. Independent quickstart baselines can appear as distinct cohorts
with missing cross-cells; use a matched controlled campaign for acceptance
comparisons.

An optional judge is a separate paid request and never overrides deterministic
validation or required checks:

```powershell
# PowerShell: create/review judge-bounds.json first.
npm run evaluate -- --runs $runs --provider openai --model 'YOUR_JUDGE_DEPLOYMENT' --wire-api responses --auth entra --credential azure-cli --subscription-id $subscriptionId --bounds "$root\judge-bounds.json" --output "$root\judge-review-v1.json"
npm run report:html -- --runs $runs --evaluation "$root\judge-review-v1.json" --bundle "$root\report-reviewed-v1" --zip
```

```bash
# Bash: create/review judge-bounds.json first.
npm run evaluate -- --runs "$runs" --provider openai --model 'YOUR_JUDGE_DEPLOYMENT' --wire-api responses --auth entra --credential azure-cli --subscription-id "$subscription_id" --bounds "$root/judge-bounds.json" --output "$root/judge-review-v1.json"
npm run report:html -- --runs "$runs" --evaluation "$root/judge-review-v1.json" --bundle "$root/report-reviewed-v1" --zip
```

Review metadata before sharing the report folder/ZIP. Raw logs, prompts, tool
arguments/results, validation output, patches, judge responses, and workspaces
are sensitive local evidence. Content previews need a reviewed hash-bound
publication manifest.

## Task design and supported configuration

Use [`benchmark.example.json`](benchmark.example.json) for controlled runs and
the [task authoring guide](docs/TASK_AUTHORING_GUIDE.md) for task-owned probes,
calibrated required/advisory checks, exact-byte requirements, and fixed rounds.
The richer [in-memory ordering scenario](scenarios/in-memory-ordering-system/task.md)
is a blueprint, not a bundled universal benchmark.

The default coding scope is `read`, `edit`, and `shell`. Optional
[Model Context Protocol](https://modelcontextprotocol.io) servers are part of
the immutable contract. Secret placeholders expand only from the process
environment; never put credentials in config files.

## Scope

- Foundry deployments must match the implemented `openai` Responses/legacy
  completions or `anthropic` Messages wire shape.
- Key remains the compatibility default when auth is omitted. Keyless requires
  explicit `--auth entra` plus a credential selector; it never silently changes
  methods or principals.
- A deterministic validation command runs once after the session. Optional
  conformance/evaluator evidence is separate from candidate-written tests.
- Finite request limits are required by the staging quickstart, but they are
  operator-reviewed safeguards, not discovered quota or guaranteed billing caps.
- Cost, token, cache, latency, and request metrics are reported only when
  captured. Missing or incomplete metering remains unavailable/unknown.
- Automated documentation/tests use local fixtures and fake transports; they
  do not prove live RBAC, capacity, model support, or coding quality.

Official references:
[Azure CLI interactive login](https://learn.microsoft.com/cli/azure/authenticate-azure-cli-interactively),
[Copilot SDK BYOK](https://github.com/github/copilot-sdk/blob/v1.0.10-preview.0/docs/auth/byok.md),
[Copilot SDK refreshable Azure Identity callback](https://github.com/github/copilot-sdk/blob/v1.0.10-preview.0/docs/setup/azure-managed-identity.md),
[Microsoft Responses](https://learn.microsoft.com/azure/foundry/openai/how-to/responses),
and [Microsoft Claude Messages/auth](https://learn.microsoft.com/azure/foundry/foundry-models/how-to/use-foundry-models-claude).

For optional doctor/runtime/capacity/native-count diagnostics, campaign
prepare/status/resume, isolation/private grading, pricing semantics, and safe
publication, continue with [Running the toolkit smoothly](docs/RUNNING_THE_TOOLKIT.md).
