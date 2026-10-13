# Running the toolkit smoothly

An operator workflow for **Coding Agent Model Evaluation Toolkit**: choose a
task, check the host and deployment, prepare an immutable cohort, run within
approved bounds, inspect acceptance, then publish reviewed evidence.
Commands below use PowerShell 7+ from the repository root. Installation and
explicitly labeled authentication/pricing operations need network access;
offline preparation/reporting do not send model requests.

**Read this before dispatch:** a working tool, token, HTTP 200, CLI exit 0 or
completed journal job is not an independent acceptance PASS. Keep execution,
candidate validation, required acceptance and measured usage separate.
Never use a failed result as permission to retry until PASS.

## Choose your path

| Goal | Start here | What it proves |
|---|---|---|
| Open a delivered report | [Offline reporting and sharing](#offline-reporting-and-sharing) | Saved evidence only; a browser needs no Azure, Node or server |
| First bounded coding comparison | [Install and select a public task](#1-install-and-select-a-public-task) | JSON/text starters with observable public requirements |
| Run your own benchmark suite | [Author tasks and expand carefully](#author-tasks-and-expand-carefully) | A campaign declares your tasks/candidates/repeats; there is no bundled universal dataset |
| Use a supplied richer benchmark blueprint | [Scenario and exploratory paths](#scenario-and-exploratory-paths) | The ordering scenario needs its documented baseline, dependencies and task-owned probe |
| Execute untrusted code or private graders | [Isolation guide](ISOLATED_EXECUTION.md) first | Separate digest-pinned Linux Docker worker prerequisites; never a local fallback |

The pinned **Copilot SDK/selected CLI** supplies sessions and coding tools;
Foundry supplies inference. This is not a Foundry deployment service, resource
provisioner or automatic model-ranking system. Keep the detailed
[auth](KEYLESS_AUTH.md), [task authoring](TASK_AUTHORING_GUIDE.md) and
[campaign/publication](CAMPAIGNS_AND_PUBLICATION.md) references nearby.

## 1. Install and select a public task

```powershell
git clone https://github.com/samsonlee0907/coding-agent-model-eval-workshop.git
Set-Location coding-agent-model-eval-workshop
$reviewedRef = 'REPLACE_WITH_REVIEWED_COMMIT_TAG_OR_BRANCH'
git fetch origin $reviewedRef
if ($LASTEXITCODE -ne 0) { throw 'Reviewed revision unavailable.' }
git switch --detach FETCH_HEAD
if ($LASTEXITCODE -ne 0) { throw 'Reviewed checkout failed.' }
node --version
npm --version
git --version
npm ci
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
npm run build
if ($LASTEXITCODE -ne 0) { throw 'Build failed; do not proceed.' }
npm run doctor -- --help
npm run campaign -- --help
```

Use the exact reviewed revision containing this guide. During staging review,
a fresh clone's default branch may still contain the older implementation;
do not assume it has these commands. Already in the intended checkout? Skip
clone/ref selection and start with the host/install checks.

The package supports Node **20.19+**. `npm ci` follows the lockfile, including
Copilot SDK **1.0.10-preview.0** and Azure Identity **4.13.3**. A successful
install is not host/runtime acceptance: test your selected executable.
Selection uses `BENCHMARK_COPILOT_CLI_PATH`, then `COPILOT_CLI_PATH`, then an
installed CLI, with the bundled executable as fallback. A standalone CLI,
Copilot subscription/login, Azure Developer CLI and Docker are not general
prerequisites. Preparation records Node/SDK/CLI version and executable hash;
the CLI's separately reported backend version may differ.

**Trusted-local is not credential isolation.** Candidate tools and validators
can reach host files, identity caches, network and other credentials. Removing
the Foundry key/endpoint from child environments does not remove everything.
Use trusted inputs/code on a suitable disposable host, or configure isolation
before preparation. Docker is optional for reports, local preparation and
trusted-local execution; private grading/isolated execution has separate
[image, daemon, resource and freezer requirements](ISOLATED_EXECUTION.md).

Copy a starter instead of modifying repository examples:

```powershell
# operator:copy
$work = '.\.benchmark-runs\operator-json-v1'
if (Test-Path -LiteralPath $work) { throw 'Choose a new versioned work folder.' }
New-Item -ItemType Directory -Path '.\.benchmark-runs' -Force | Out-Null
Copy-Item -LiteralPath '.\examples\custom-campaign' -Destination $work -Recurse
$spec = Get-Content -LiteralPath "$work\campaign.json" -Raw | ConvertFrom-Json
$taskFile = 'json-task.json'
$spec.id = 'operator-json-v1'
$spec.tasks = @($spec.tasks[1])
$spec.candidates = @($spec.candidates[0])
$spec.repeats = 1
$task = Get-Content -LiteralPath "$work\$taskFile" -Raw | ConvertFrom-Json
$deployment = 'YOUR_EXISTING_RESPONSES_DEPLOYMENT'
$spec.candidates[0].candidate.model = $deployment
```

This selects **one task x one candidate x one repeat**. For text, choose
`text-task.json` and `$spec.tasks[0]` from the freshly loaded original example
instead of index 1, and use a distinct work/campaign ID.

| Supplied task | Visible output | Independent required R1 |
|---|---|---|
| [JSON](../examples/custom-campaign/json-task.json) | Read `numbers.json`; write `answer.json`; fixed generic review | An object with numeric `sum: 16`; whitespace/additional fields permitted. Scalar `16` is valid JSON but **FAILS** the requirement |
| [Text](../examples/custom-campaign/text-task.json) | Read `input.txt`; write `result.txt`; fixed generic review | `OK`, optionally followed by LF or CRLF. Arbitrary extra whitespace is not approved merely because the visible validator trims it |

Both examples have a separate evaluator file. Their task instructions,
initial prompt, input bytes and follow-up review are part of comparison
provenance. Do not silently change them for one candidate.

### Exact bytes are a different task

The separate [exact-text control](../examples/custom-campaign/exact-text-task.json)
is **not** a default task. It requests initial `OK` plus LF and final two-byte
`OK`. Native line-oriented `apply_patch` success did not certify newline
removal on the tested Windows CLI. For genuinely byte-exact requirements,
declare `execution.exactContentEdits: true` with `edit` before preparation.
Trusted-local sessions retain native tools and add the bounded
`custom:write_file_exact`; read/edit-only is not widened to shell.
Isolated writes stay worker-owned, never a host writer.

The public doctor exact control creates native `FIRST` with a newline, then
tests final two-byte `OK` through the exact writer. It does **not** prove
initial `OK\n` or execution of your authored phases. A final-only evaluator
cannot prove phase history. Earlier stricter initial-LF/final-two-byte
acceptance controls were separately authored tests, not failures of the
optional-newline public task. See [exact-edit semantics and scope](TASK_AUTHORING_GUIDE.md#exact-utf-8-editing-without-shell).

## 2. Bind identity, endpoint and actual deployment capacity

Skip cloud setup for an offline-only preview; placeholder deployments can
remain. For paid execution, confirm the **existing** resource/deployment's
model version, supported API/reasoning settings, SKU/region, inference access
and network reachability with its administrator.

### Keyless local Azure CLI path

These are **authentication/management network operations, not inference**.
Azure CLI must be installed on the orchestrator host. If already signed in,
check the intended cached account instead of repeating login unnecessarily.

```powershell
$tenantId = 'REPLACE_WITH_TENANT_UUID'
$subscriptionId = 'REPLACE_WITH_SUBSCRIPTION_UUID'
az version
az login --tenant $tenantId
if ($LASTEXITCODE -ne 0) { throw 'Login failed.' }
$account = az account show --subscription $subscriptionId --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Selected subscription is unavailable.' }
if ($account.tenantId -ne $tenantId) { throw 'Selected subscription belongs to a different tenant.' }
$env:FOUNDRY_ENDPOINT = 'https://YOUR_RESOURCE.services.ai.azure.com'
Remove-Item Env:FOUNDRY_API_KEY -ErrorAction SilentlyContinue
$spec.candidates[0].foundryProvider.auth = [pscustomobject]@{
    mode = 'entra'; credential = 'azure-cli'; subscriptionId = $subscriptionId
}
```

Use **subscription OR tenant**, never both for this pinned Azure CLI credential.
The subscription-only recipe checks the expected tenant during setup; it
does not store a second expected-tenant runtime restriction. Runtime binds the
configured selector/auth mode and endpoint provenance, not an independently
verified live principal identity. Keep the login stable. Tenant-only instead
uses the current CLI default account as principal. The toolkit does not run
`az account set`, fall back to another account/key, or use an implicit
`DefaultAzureCredential` chain. Never paste/dump tokens or request headers.

`FOUNDRY_ENDPOINT` is the **resource root**, without project paths,
`/openai/v1`, `/anthropic`, query or fragment. For this `openai` provider the
toolkit derives the OpenAI resource base `/openai/v1`; explicit
`wireApi: responses` uses its `/responses` route. `candidate.model` selects
the exact deployment, not a marketing name. The current token callback
requests fixed **`https://ai.azure.com/.default`** through Azure Identity's
refresh/caching behavior; there is no scope override. Token success does not
prove resource inference RBAC, model availability, tool use or coding quality.
Other endpoint families need their own verified support.

For the supported **key** alternative, follow the
[masked key setup](../README.md#3-configure-foundry-authentication) instead;
omitted auth means key, not automatic keyless. Managed/workload identity are
supported configuration paths on properly configured hosts, not local login
shortcuts. **Key authentication was explicitly skipped**, not PASS or FAIL,
in the keyless acceptance described below. Managed/workload hosts and private
Docker grading were not live-tested there either; lack of live acceptance is
not evidence that these capabilities fail or should be removed.

### Capacity is not the example policy

If separately authorized for resource-management reads, this optional query
does not change shared defaults or send inference:

```powershell
$resourceGroup = 'YOUR_RESOURCE_GROUP'
$resourceName = 'YOUR_RESOURCE_NAME'
az cognitiveservices account deployment show --subscription $subscriptionId --resource-group $resourceGroup --name $resourceName --deployment-name $deployment --query '{sku:sku,model:properties.model,rateLimits:properties.rateLimits}' --output json
if ($LASTEXITCODE -ne 0) { throw 'Deployment observation unavailable; ask the administrator.' }
```

Review the exact deployment, not subscription-wide quota or a model context
limit. Missing rate limits mean **unknown**, not unlimited. Capacity-unit
RPM/TPM mapping varies by model/SKU/version; no universal conversion from
`sku.capacity` is safe. Record the current observation and an approved local
share before preparing:

```powershell
# operator:capacity
$observedRpm = [int](Read-Host 'Observed deployment RPM')
$observedTpm = [int](Read-Host 'Observed deployment TPM')
$approvedRpm = [int](Read-Host 'Approved local RPM, allowing for shared traffic')
$approvedTpm = [int](Read-Host 'Approved local reservation TPM, allowing for growth/headroom')
if ($observedRpm -lt 1 -or $observedTpm -lt 1 -or $approvedRpm -lt 1 -or $approvedTpm -lt 1 -or $approvedRpm -gt $observedRpm -or $approvedTpm -gt $observedTpm) { throw 'Positive approved ceilings within observed limits required.' }
$spec.candidates[0].foundryProvider | Add-Member -NotePropertyName capacity -NotePropertyValue ([pscustomobject]@{
    source = 'administrator-declared'; observedAt = [DateTime]::UtcNow.ToString('o')
    endpoint = $env:FOUNDRY_ENDPOINT; deployment = $deployment; wireApi = 'responses'
    requestsPerMinute = $observedRpm; tokensPerMinute = $observedTpm
}) -Force
$spec.requestBounds.requestsPerMinute = $approvedRpm
$spec.requestBounds.tokensPerMinute = $approvedTpm
```

Use `source = 'azure-management-observation'` instead if these values were
actually returned by the management query. This binding is an observation,
not real-time free capacity. Preparation/doctor check local limits and
endpoint/deployment/protocol binding; dispatch rechecks the environment.
Independent processes/shared traffic are outside the campaign's controller.
Its rolling minute window permits bursts; it does not guarantee evenly spaced
requests or immunity to shorter provider windows.

**Do not change Azure capacity to bypass a guard.** A capacity change is a
separate administrator action requiring explicit approval, fresh exact
quota/availability checks, model/version-specific unit mapping, polling to a
terminal provisioning state, and comparison of before/after metadata to prove
only the approved SKU capacity changed. Refresh the observation and declare a
new profile afterward. This guide provides no mutation commands.

## 3. Review finite policy and calibrate before preparation

Example bounds are not safe universal defaults. Review every request, token,
output, clock, memory and protective USD field. For a first diagnostic smoke,
sequential read/edit-only, `retries: 0` and one attempt make evidence easier to
interpret; these are **deliberate profile choices**, not mandatory product
defaults. They differ from the copied examples' shell/retry policy.

```powershell
# operator:policy
$task.contract.execution.tools = @('read', 'edit')
$task.contract.execution.retries = 0
$task.contract.execution.sessionTimeoutMs = 900000
$spec.bounds.concurrency = 1
$spec.bounds.maxAttemptsPerCell = 1
$spec.bounds.deadlineMs = 960000
$spec.requestBounds.deadlineMs = 900000
$spec.requestBounds.maxRequests = 10
$spec.requestBounds.maxOutputTokens = 2000
$spec.requestBounds.maxTokens = [int](Read-Host 'Approved total conservative token reservations for this one attempt')
$spec.bounds.maxRequests = $spec.requestBounds.maxRequests
$spec.bounds.maxReservedTokens = $spec.requestBounds.maxTokens
$spec.bounds.maxReservationUsd = [double](Read-Host 'Approved protective USD reservation ceiling')
$spec.bounds.reservationUsdPerMillionTokens = [double](Read-Host 'Reviewed conservative USD-per-million reservation rate')
$task.contract.candidate = $spec.candidates[0].candidate
$task.contract.foundryProvider = $spec.candidates[0].foundryProvider
$task | Add-Member -NotePropertyName requestBounds -NotePropertyValue $spec.requestBounds -Force
$spec | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath "$work\campaign.json" -Encoding utf8
$task | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath "$work\$taskFile" -Encoding utf8
$state = "$work\state"
```

This finite smoke declares high reasoning from the example, 2,000 inclusive
output tokens, ten physical requests, a 15-minute request/session window and
16-minute campaign window. It is **not runnable until fit/auth/capacity pass**;
it is not a guarantee those tasks can finish. Review/adjust all inherited
fields, including `maxRequestBytes`, input bounds and minimum free memory.
The output ceiling includes reasoning overhead, not just visible text/files.
A proven output-limit terminal calls for an explicitly reviewed new allowance,
not unlimited output or silently reduced effort.

Campaign reservations cover each admitted attempt's declared request/token
maximum and are not refunded as billing. Independent one-cell campaigns do
not share an aggregate clock/budget: the operator must track the overall
deadline, requests, reservations, known usage and cooldowns externally.
See [bounded execution and dispatch certainty](CAMPAIGNS_AND_PUBLICATION.md#bounds-and-dispatch-certainty).

### Optional offline calibration for the supplied starters

The examples ship required checks but do not ship reference calibration.
For stronger acceptance provenance, the following **local Node checks only**
create positive, negative and equivalent-valid references for the selected
public JSON/text starter, then pin its unchanged policy:

```powershell
# operator:calibration
@'
import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { calibrateEvaluator } from './dist/index.js';
const work = resolve(process.argv[2]);
const specPath = join(work, 'campaign.json');
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const declared = spec.tasks[0];
const taskPath = join(work, declared.config);
const task = JSON.parse(readFileSync(taskPath, 'utf8'));
const policy = JSON.parse(readFileSync(join(work, declared.evaluator), 'utf8'));
const json = declared.id === 'json-result';
if (!['json-result', 'text-result'].includes(declared.id) || policy.checks.length !== 1)
  throw new Error('Provide task-specific references for a custom/multi-check policy.');
const root = join(work, 'calibration-references');
if (existsSync(root)) throw new Error('Reference destination exists; preserve it.');
mkdirSync(root);
const references = ['positive', 'negative', 'equivalent'].map(kind => {
  const workspace = join(root, kind);
  cpSync(resolve(dirname(taskPath), task.workspacePath), workspace, { recursive: true });
  const content = json
    ? kind === 'negative' ? '16\r\n' : kind === 'equivalent' ? '{ "extra": true, "sum": 16 }\n' : '{"sum":16}\r\n'
    : kind === 'negative' ? 'NOT_OK\n' : kind === 'equivalent' ? 'OK\r\n' : 'OK';
  writeFileSync(join(workspace, json ? 'answer.json' : 'result.txt'), content);
  return { id: kind, kind, workspace, expected: { [policy.checks[0].id]: kind === 'negative' ? 'fail' : 'pass' } };
});
const calibration = await calibrateEvaluator(policy, references);
writeFileSync(join(work, 'calibration.json'), JSON.stringify(calibration, null, 2) + '\n');
if (!calibration.calibrated) throw new Error('Calibration did not certify the reference controls.');
declared.calibration = 'calibration.json';
spec.requireCalibratedEvaluators = true;
writeFileSync(specPath, JSON.stringify(spec, null, 2) + '\n');
console.log(JSON.stringify({ calibrated: calibration.calibrated, policyHash: calibration.policyHash }));
'@ | node --input-type=module - "$work"
if ($LASTEXITCODE -ne 0) { throw 'Calibration failed; no paid admission.' }
```

Custom checks need their own requirement-mapped fixtures; do not merely set a
calibrated flag. Generic checks run sequentially: exit 0 PASS, declared failure
exits (default 1) required FAIL/advisory WEAK, other exits/timeouts/spawn errors
ERROR. Calibration binds observations to policy/reference hashes. Keep private
oracle assets outside candidate inputs; see [private isolated grading](CAMPAIGNS_AND_PUBLICATION.md#trusted-local-versus-credential-isolated-execution).

## 4. Run the pre-dispatch gates in order

```powershell
# operator:offline
npm run doctor -- --config "$work\$taskFile"
if ($LASTEXITCODE -ne 0) { throw 'Local configuration/prerequisite check failed.' }
npm run doctor -- --config "$work\$taskFile" --verify-runtime
if ($LASTEXITCODE -ne 0) { throw 'Selected coding runtime failed; stop.' }
npm run doctor -- --config "$work\$taskFile" --verify-request-fit
if ($LASTEXITCODE -ne 0) { throw 'Initial request fit blocked or unverified; stop.' }
```

| Gate | What it proves | What it does not prove |
|---|---|---|
| Plain `doctor` | Local config, runtime/prerequisites and supplied capacity binding | Cloud auth, inference, coding quality |
| `--verify-runtime` | Actual selected SDK/CLI native read/list/create/edit and fixed-round controls against localhost fake Responses | A model's ability to choose tools; live endpoint/RBAC; your task acceptance |
| `--verify-request-fit` | Actual initial task serialization through production shaping, hashes/bytes/output/reservation/headroom | Later context growth, provider token estimate, free shared capacity or full-plan completion |
| Separate `--acquire-auth` | Entra token-only acquisition; key mode checks presence | Inference permission, model availability, file creation or acceptance |

Runtime catalogs, not model marketing or schema allowance, determine available
tools. Read/edit can resolve native `view`/`glob`/`apply_patch` identifiers;
verification never adds shell to make that contract work. These local probes
currently target explicit OpenAI Responses; initial fit covers trusted-local
without MCP. Unsupported modes remain unverified, not silently downgraded.
Container coding verification additionally requires explicit
`--allow-container-probe` consent and owned Docker resources; follow the
isolation guide instead of appending it blindly.

Reservation is **the entire transformed serialized UTF-8 request bytes plus
the declared inclusive output ceiling**. SDK system/context/tool schemas count.
It is deliberately pessimistic, not billed tokens or a vendor tokenizer.
Do not use bytes/4, unverified deployment-to-encoding aliases or optimistic
past usage to defeat the guard. Pacing/cooldown cannot shrink an individually
unfit request. Keep initial and later growth headroom inside the approved
deployment share; stop if no supported profile fits.

After the local gates and intended keyless login, this optional **token-only
network** check does not send inference:

```powershell
npm run doctor -- --config "$work\$taskFile" --acquire-auth
if ($LASTEXITCODE -ne 0) { throw 'Selected authentication failed; do not switch identities or run inference.' }
```

## 5. Prepare, preview, then deliberately authorize one paid cell

```powershell
# operator:prepare
npm run campaign -- prepare --spec "$work\campaign.json" --directory $state
if ($LASTEXITCODE -ne 0) { throw 'Immutable preparation failed.' }
npm run campaign -- status --directory $state
npm run campaign -- report --directory $state --output "$work\preview-v1" --zip
if ($LASTEXITCODE -ne 0) { throw 'Offline publication failed.' }
Invoke-Item -LiteralPath "$work\preview-v1\index.html"
```

Expected before dispatch: `prepared.json`, one **MISSING** cell, zero attempts,
offline preview folder/ZIP. Configuration paths are relative to the manifest;
workspace paths are relative to each config. Preparation snapshots regular
inputs, omitting `.git`, `node_modules` and toolkit artifact directories.
Prepare required dependencies explicitly; do not assume omitted host modules
or a reference's parent directory will exist in a grading copy.

**Next commands incur paid inference.** Run only after explicit approval of
the exact task, identity, deployment, bounds and execution mode:

```powershell
# operator:paid
npm run campaign -- run --directory $state --allow-paid
$runExit = $LASTEXITCODE
npm run campaign -- status --directory $state
npm run campaign -- report --directory $state --output "$work\result-v1" --zip
```

Retain `$runExit`, status, actual files and the **original persisted** grade.
A one-cell campaign contains no other cell to admit, but its task may require
multiple model requests for native tools and review.

| Local artifact | Inspect for |
|---|---|
| `prepared.json` | Inputs/prompts/rounds/runtime/evaluator/bounds; sensitive, not a shareable manifest |
| `journal.ndjson`, derived `state.json` | Reservations, phases, ownership/draining history; journal is authoritative |
| `runs\<attempt-id>\run.json` | Execution status, candidate validator/outcome, accounting and provenance |
| `runs\<attempt-id>\grade.json` | Exact run/contract/workspace/policy binding, required statuses and categorical ERROR diagnostics |
| `attempts\<attempt-id>\input` | Trusted-local actual output; isolated export uses the workspace recorded in `run.json` |
| `diagnostics.json`, normalized events | First safe diagnostic and known terminal usage; raw logs may contain sensitive data |

Inspect `run.artifacts.workspace` rather than guessing paths for other modes.
Missing required grade is UNGRADED, not a synthetic failed grade.

### Operator admission and stop policy

The current multi-cell runner does **not** guarantee automatic STOP on every
unsafe interruption or evaluator ERROR. Clean content FAILs may continue
scheduled work. For a stricter initial safety policy, organize explicitly
bounded, sequential **one-cell public campaigns**, inspect each result and
apply reviewed aggregate limits/cooldowns externally before preparing/admitting
the next cell. There is no `--cell` flag or automatic cross-process budget.
This was an approved operator organization, not a hidden private driver.

Stop new operator admission on missing grade, evaluator ERROR, provider/auth,
capacity/budget failure, unknown dispatch or an unsafe incomplete task/round.
Keep known usage and interrupted outputs. A clean semantic FAIL is a real
result, not an infrastructure problem; continue a planned comparison only
under its already reviewed policy, never by retrying that failure.
Use actual provider retry/reset information when available; do not invent a
universal cooldown. Explicit external gaps also change latency measurements.

### Resume is not a grading-only command

Inspect the state and obtain approval for its full possible scope first:

```powershell
npm run campaign -- resume --directory $state --allow-paid
```

**This can admit pending cells and incur paid requests.** It can finalize
retained outputs without inference, but the flag is not a grading-only gate.
Do not resume an old multi-cell acceptance record merely to get a grade.
An independently graded copy is diagnostic evidence, not recovery of the
original campaign's CLI grade.

Completed content FAILs are skipped. Ambiguous/partial processed work is not
automatically replayed. `--recover-rejected` is only for evidence-certified
transient rejected-only HTTP 429 attempts within immutable limits;
`--recover-lock` requires a demonstrably dead same-host owner, not a live lock.
Neither is a generic repair switch. See [exact recovery rules](CAMPAIGNS_AND_PUBLICATION.md#prepare-run-resume).

Changed source/runtime, prompt, input, tools, effort, output allowance, pacing,
evaluator or environment needs a **new declared cohort and finite clock**.
Do not rebind prepared state, extend an expired admission deadline or overwrite
old grades to claim a fix. Eligible retained-output finalization has its own
explicit bounded recovery window; it does not renew ambiguous inference.

## Author tasks and expand carefully

For your own suite, copy a task config and input folder per task, then declare
task IDs/config/evaluator paths and candidate IDs/deployments in campaign JSON.
No fixed category mapping, private graders or model names are required.
Start with one cell before increasing the Cartesian product or repeats.
Use [the actual task schema](../src/config-schema.ts),
[campaign schema](../src/campaign.ts), [evaluator schema](../src/task-evaluator.ts)
and [authoring guide](TASK_AUTHORING_GUIDE.md), not imaginary flags:

| Field | Meaning |
|---|---|
| `contract.task.prompt` | Initial work request with observable requirements; not a follow-up |
| `contract.execution.instructions` | Stable operating policy, identical across compared candidates |
| `rounds[]` | Fixed follow-ups, order/count and `enqueue`/`immediate` mode; no per-model rescue turn |
| `workspacePath`, repository/input bindings | Clean starter bytes and baseline/environment, not a previous candidate's output |
| `task.version/title/taskType/tags` | Optional reporting metadata; task ID must match its campaign declaration |
| `tools`, reasoning/output/time/retry policy | Actual capability/profile provenance; model support must be verified |
| Evaluator/calibration/private inputs | Requirement-mapped checks, exact policy/reference hashes; private assets require isolated mode |

Match task inputs, full prompts/instructions, rounds, Node/SDK/CLI/tool profile,
resource/protocol/auth, reasoning/output bounds and evaluator policy.
Version intentional variations as distinct cohorts. Required/advisory/error
signals are not interchangeable. Do not count missing candidates as equal
coverage, infer a deployment from a label, or treat a calibrated check as broad
proof that the task represents production.

### Scenario and exploratory paths

The [ordering-system blueprint](../scenarios/in-memory-ordering-system/task.md#how-to-run-this-scenario)
has an initial task, two review/handoff rounds and a separate task-owned
behavioral probe. Its controlled template has placeholders for clean baseline,
environment, deployment, workspace and probe paths; it defaults to legacy
key/completions, not this guide's keyless Responses profile.
Resolve probe commands/dependencies before preparing, especially for isolated
grading. Promoting it into your own suite uses the same campaign task config
mechanism; this is not a built-in private benchmark loader.

Exploration can prepare a disposable config **without inference**:

```powershell
npm run quickstart -- --task-file '.\scenarios\in-memory-ordering-system\round1.prompt.txt' --provider openai --model 'YOUR_DEPLOYMENT' --wire-api responses --auth key --bounds '.\examples\request-bounds.example.json' --prepare-only --output '.\.benchmark-runs\ordering-exploration-v1'
```

Review a copied bounds file first; the example limits are not deployment
capacity. This creates `benchmark.local.json`, a `workspace` and baseline;
it does not authenticate in prepare-only mode. Configure the saved provider
for the intended key/Entra method and capacity, then run the same doctor gates.
Quickstart adds its own generic validation/build follow-up; it does **not**
reproduce the full scenario's controlled review/probe contract.

`bench --config <saved-config>` starts **paid inference immediately**.
Quickstart without `--prepare-only` and optional `evaluate` judge also start
paid inference, with no `--allow-paid` gate. Judge scores do not replace
required deterministic acceptance. Do not run any of them as host checks.

## Read results without overstating them

| Execution/evidence | Normalized phase/status | Interpretation |
|---|---|---|
| Completed, required campaign grade absent | `grading-pending` / UNGRADED | Required evidence missing; no invented grader/model/provider failure |
| Required recorded PASS / FAIL / ERROR | `graded` / respective verdict | Grading attempted; phase is not PASS. ERROR is infrastructure/evaluator uncertainty |
| Candidate-only, no required evidence | `finalized` / UNGRADED acceptance | Candidate validation may resolve; independent acceptance was not proved |
| Interrupted fixed work plan | Execution/interrupted | Green output/validator cannot upgrade incomplete execution |
| Declared cell never run | MISSING | Not free, not PASS, not a measured quality failure |

CLI exit 0/journal completed describes orchestration, not required grade PASS.
The report selects latest clean completion **including content FAIL**, not
latest PASS; historical attempts/recovery remain visible. Clean-completed
counts are execution coverage, not completed grading/comparison coverage.

Legacy `portfolio --runs` deliberately counts **candidate-validation**
resolution only, with required acceptance **Not assessed**. Zero runtime
harness failures does not prove a campaign was graded. `report:html --runs`
also imports run-level/legacy probe evidence, not the external campaign plan.
For actual required grades and missing cells use campaign status/report or
`report:html --evidence` with normalized campaign evidence.

### Usage, cost and what-if pricing

Prefer retained physical terminal meters for known usage, including
failed/incomplete responses when reported. SDK usage records are not physical
request counts. Reasoning tokens are already a **subset of output**; cache
subdivisions are not extra tokens to add again. Selected-run and all-attempt
costs have different denominators. Unknown/missing failed-request usage remains
unknown; do not reconstruct it from earlier averages or call it zero.

Serialized-byte reservations and declared protective USD ceilings are
admission declarations, **not measured tokens, invoices or guaranteed billing
caps**. SDK recorded cost multipliers, including zero, are not USD.
Actual billing can remain unavailable even when every token meter is present.

Optional `prices:refresh --runs <saved-runs>` makes public network requests to
official published pricing sources: Azure OpenAI's pricing page and, for the
Anthropic path, Claude API pricing with Foundry billing/cache documentation.
It writes `pricing-snapshot.json` with time, sources and available scenarios;
unresolved aliases/regions/meters remain unavailable. Review aliases explicitly
with supported `--pricing-model recorded=Official Label` and `--region`.
Preserve an existing snapshot before another refresh (this file can be
replaced). A later snapshot is a **what-if**, not a rewrite of recorded
campaign prices, a negotiated invoice or real-time offline HTML.
Campaign pricing must be declared/pinned before preparation; see
[pricing semantics](CAMPAIGNS_AND_PUBLICATION.md#evidence-pricing-and-publication).

## Offline reporting and sharing

These forms require no auth/inference after installation. Choose new output
destinations; existing portable folders/ZIPs are refused rather than replaced:

```powershell
# From an existing campaign, preserving declared missing/required evidence:
npm run campaign -- status --directory '.\.benchmark-runs\my-cohort\state'
npm run campaign -- report --directory '.\.benchmark-runs\my-cohort\state' --output '.\.benchmark-runs\my-cohort\report-v2' --zip
# From normalized evidence, not a regrade:
npm run report:html -- --evidence '.\reviewed\evidence.json' --bundle '.\reports\review-v1' --zip
# Explicit compatible single HTML; choose a new filename yourself:
npm run report:html -- --evidence '.\reviewed\evidence.json' --output '.\reports\review-v1.html'
# Run-only legacy/candidate-validation scope:
npm run report:html -- --runs '.\.benchmark-runs\saved-artifacts' --bundle '.\reports\run-only-v1'
npm run portfolio -- --runs '.\.benchmark-runs\saved-artifacts' --output '.\reports\candidate-validation.md'
```

The folder contains `index.html`, `evidence.json`, selected-results and
task-types JSON/CSV, `previews.json` and `integrity.json`, plus explicitly
approved artifacts if any. ZIP uses relative paths for portability.
Generation stages/verifies before publication. Single HTML is portable
metadata evidence, but approved previews/originals and ZIP require the folder
path; `--output` cannot be combined with `--zip`/`--publication`.
Single-file APIs can replace their destination, so pick a new name.

Default publication is **metadata-safe**, not permission to share every local
file. Review IDs/labels too. Do not copy raw run logs, CLI stderr, prompts,
environment, tokens/headers, credentials or private oracle assets into reports.
For content, adapt the [manifest](../examples/publication.example.json):
review exact source/output bytes, bind task/attempt/root/relative path and
SHA-256, and retain honest FAIL outputs instead of correcting them for display.

```powershell
(Get-FileHash -LiteralPath '.\reviewed\answer.json' -Algorithm SHA256).Hash.ToLowerInvariant()
npm run campaign -- report --directory $state --output "$work\reviewed-v1" --zip --publication '.\reviewed\publication.json'
```

The manifest path is an example destination you must create, not a generated
file. Previews support bounded text/JSON/CSV, inert sanitized HTML and approved
raster images. PDF/OCR and workbook recalculation are not provided; cached
workbook representations are labeled. Original active downloads are separately
opt-in. An optional report deployment field may say **not recorded** if
`candidate.deployment` was omitted; use actual configuration plus a reviewed
companion/manifest binding, never infer it from a label.

Open `index.html` directly and inspect methodology, matrix, filters, selected
cell provenance, metadata replay, required verdicts, known/missing usage and
CSV/JSON consistency. Browser Blob/export handler success is not proof that
an OS download actually completed. Check the saved file or use the already
generated exports. Preserve the whole folder when using relative artifact
links. Verify integrity through the exported API:

```powershell
node --input-type=module -e "import { verifyReportBundle } from './dist/index.js'; verifyReportBundle(process.argv[1]); console.log('Bundle verified');" "$work\reviewed-v1"
Get-FileHash -LiteralPath "$work\reviewed-v1.zip" -Algorithm SHA256
```

Copy the reviewed folder/ZIP to a **distinct** delivery directory only after
review/hash checks, without overwriting historical `Latest` reports. Verify
the copied folder again and compare source/destination ZIP hashes.
Never share a parent work/state directory just because its report is safe.

## Diagnose and stop safely

Read the **first** actionable categorical diagnostic, before secondary
bridge/query fallout. Retain evidence without dumping secrets or full
provider errors. This table describes operator actions, not broader automatic
stop/retry enforcement:

| Symptom | Likely layer / evidence | Safe next action |
|---|---|---|
| Tenant+subscription rejected | CLI credential selector conflict before inference | Choose one intended selector; perform expected-tenant setup check; no fallback/global default change |
| Token acquired, then 401/403 | Audience/auth or resource inference RBAC/network | Verify exact endpoint/scope/principal/resource permission with administrator; login/management Contributor is insufficient |
| 404/unavailable deployment | Deployment/resource/model version/protocol binding | Confirm existing deployment/API availability; no model substitution disguised as the same cohort |
| Runtime probe has no read/edit tools | Selected CLI catalog/host dependency | Correct declared supported runtime; rerun local gate. Do not add shell or downgrade silently |
| Admission `not-dispatched`, upstream null, response bytes 0 | Local request/reservation/pacing/deadline refusal | Preserve prior meters. A larger deployment observation does not override a smaller local bound; review a new profile, not unknown spend |
| Single reservation exceeds TPM | Serialized SDK context plus output cannot fit | Waiting/lower concurrency cannot shrink it. Supported reviewed shape or approved sufficient capacity, otherwise stop |
| Explicit transient HTTP 429 rejection | Certified pre-processing rejection, not partial work | Bounded retry policy only if certainty permits; honor retained retry information and immutable limits |
| HTTP 200 stream `rate_limit_exceeded` | Post-headers provider rate limit, possibly processed | Stop/cooldown/review allocation/shared traffic; no automatic replay, no definite rejection, missing usage stays unknown |
| Terminal incomplete/max-output/content-filter/failed | Categorical provider terminal evidence | Preserve reported usage; do not call success. Change allowance/policy only in a reviewed new cohort; do not guess cause from generic older errors |
| Truncated/partial HTTP 200 or disconnect | Ambiguous processed work | Retain known meters, stop admission, no retry-until-PASS or reconstructed old usage |
| Windows validator/grader ENOENT or old Socket read ENOTCONN | Host cwd/spawn/stdio, not model/provider quality | Inspect safe stage/error code and executable/shell/temp usability. Preserve original output; no global path toggles or broad process kill |
| Bad quoted command/missing dependency | Local command/working-directory/setup | Check actual command on disposable references; use noninteractive task-owned setup and a new cohort when bindings change |
| Required grade absent | Grading pending/unknown, not proof of failure | UNGRADED; stop operator admission and investigate. Do not blindly resume pending cells or promote a diagnostic copy |
| Required grade ERROR | Evaluator/setup/spawn/timeout infrastructure | Keep ERROR separate from PASS/content FAIL; CLI job completion does not fix it |
| Required semantic FAIL after clean review | Real task result, e.g. scalar JSON rather than object | Retain original bytes/grade and report FAIL. Do not relax requirements or rerun that candidate until PASS |
| Prepared runtime/hash mismatch, dead clock or budget exhausted | Immutable cohort/protective bounds | Preserve history; reviewed changed source/profile gets a new cohort/clock, not hidden rebinding |
| Report destination exists | Publication protection | Choose a new versioned destination; do not delete/overwrite the good report to force publication |

Grading/calibration now use compact, uniquely owned temporary snapshot copies
with exact byte/hash binding and cleanup. The observed Node 26.5.1/Windows
nested-copy failure was `ENOENT`, previously obscured by unhandled Socket
read `ENOTCONN`. Its measured character threshold is **not a universal OS law**.
An unusable OS temp root still yields explicit infrastructure ERROR.
Shared validation handles child/stdin/stdout/stderr failures with finite
timers/output capture/owned process-tree cleanup. No registry toggle, shared
user-directory relocation, broad process-name kill or SDK guardrail removal
is required. See [Windows grading scope](CAMPAIGNS_AND_PUBLICATION.md#windows-grading-working-directories).

## Lessons from observed runs, not guarantees

A clean four-cell follow-up used two tiny public tasks and two existing
deployments, organized as sequential one-cell campaigns. All four persisted
calibrated original R1 grades: three PASS and one JSON content FAIL (a scalar
`16`, not the required object). The generic review completed; no requirement
was relaxed or failure retried. Twenty-four physical requests had reported
meters with no provider ambiguity, missing grades or infrastructure ERROR.
Both deployments' then-approved allocation was observed as 50,000 TPM /
50 RPM; that is a historical observation, **not this guide's quota/default**.
The run used deliberate gaps exceeding two minutes between cells.
Known usage totaled 132,046 input-plus-output tokens; reasoning was a subset
of output, SDK cost zero was not USD, and the invoice remained unknown.
Reviewed public-CLI folder/ZIP/exports were browser-inspected and copied
separately after hash checks, without overwriting historical reports.

Older stopped evidence remained unchanged and ungraded where no original
grade existed. Earlier quota mismatch, local growth refusal, byte-edit tool
limitations and Windows grading-copy errors were separate lessons, not
retroactive reinterpretations of old unknown provider failures.

This establishes a bounded path through the tested keyless/runtime/public
tasks, not broad ranking, repeatability, another model's equivalence or
production routing. With one sample per cell, two small tasks, fixed order,
cache/latency/pacing and differing tool behavior, comparative time/token
figures are confounded. More representative matched tasks/repeats and honest
all-attempt accounting are required before drawing general conclusions.

## Official references and implementation truth

Use owner documentation for external behavior, and this checkout's public
help/schema for what the toolkit actually exposes. Vendor examples are not
permission to paste tokens, change global accounts or widen tool scope.

| Topic | Official reference |
|---|---|
| Pinned SDK runtime/BYOK and refreshable bearer callback | [Copilot SDK 1.0.10-preview.0](https://github.com/github/copilot-sdk/tree/v1.0.10-preview.0), [exact-tag Azure Identity guide](https://github.com/github/copilot-sdk/blob/v1.0.10-preview.0/docs/setup/azure-managed-identity.md), [custom tools](https://github.com/github/copilot-sdk/blob/v1.0.10-preview.0/docs/getting-started.md#step-4-add-a-custom-tool) |
| Azure CLI credential arguments and conflict | [Azure Identity 4.13.3 source](https://github.com/Azure/azure-sdk-for-js/blob/@azure/identity_4.13.3/sdk/identity/identity/src/credentials/azureCliCredential.ts), [Azure CLI 2.65.0 token source](https://github.com/Azure/azure-cli/blob/azure-cli-2.65.0/src/azure-cli-core/azure/cli/core/_profile.py) |
| Resource Responses/auth/model support | [Microsoft Responses guide](https://learn.microsoft.com/azure/foundry/openai/how-to/responses), [resource RBAC](https://learn.microsoft.com/azure/foundry-classic/openai/how-to/role-based-access-control), [reasoning limits](https://learn.microsoft.com/azure/foundry/openai/how-to/reasoning) |
| Quota units, estimated-token/short-window limits and reads | [Microsoft quota guide](https://learn.microsoft.com/azure/foundry/openai/how-to/quota), [deployment CLI reference](https://learn.microsoft.com/cli/azure/cognitiveservices/account/deployment) |
| Host subprocess and temp/path behavior | [Node 26.5.1 child_process](https://nodejs.org/docs/v26.5.1/api/child_process.html), [Node temporary directories](https://nodejs.org/docs/v26.5.1/api/fs.html#fsmkdtempsyncprefix-options), [Windows path guidance](https://learn.microsoft.com/en-us/windows/win32/fileio/maximum-file-path-limitation) |
| Optional Docker boundary | [Docker installation](https://docs.docker.com/engine/install/), [digest references](https://docs.docker.com/reference/cli/docker/image/pull/), [pause/freezer](https://docs.docker.com/reference/cli/docker/container/pause/) |
| Implemented published-price sources | [Azure OpenAI pricing](https://azure.microsoft.com/en-us/pricing/details/azure-openai/), [Claude API pricing](https://claude.com/pricing#api), [Foundry Claude billing](https://learn.microsoft.com/azure/foundry/foundry-models/concepts/claude-models-billing), [cache pricing](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#1-hour-cache-duration) |

Local truth: [package scripts/version](../package.json),
[doctor](../src/doctor-cli.ts), [campaign CLI](../src/campaign-cli.ts),
[report CLI](../src/html-report-cli.ts), [task schema](../src/config-schema.ts),
[auth](../src/auth.ts), [request bounds](../src/request-policy.ts) and
[pricing implementation](../src/pricing.ts). Recheck public `--help` and rerun
offline host/shape gates after a deliberate runtime upgrade; a new version is
not automatically comparable to a historical cohort.
