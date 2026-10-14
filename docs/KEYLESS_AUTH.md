# Keyless Microsoft Entra authentication

Start with the [README keyless quickstart](../README.md#keyless-setup-preferred)
for two exploratory provider runs, or [operator installation and configuration](RUNNING_THE_TOOLKIT.md#1-install-and-select-a-public-task)
and [campaign first-run usage](RUNNING_THE_TOOLKIT.md#5-prepare-preview-then-deliberately-authorize-one-paid-cell)
for calibrated required acceptance. This guide explains the authentication
steps and boundaries in more detail. Docker is unrelated to choosing key
versus keyless authentication.

## Local developer setup

1. Install [Azure CLI on Windows](https://learn.microsoft.com/cli/azure/install-azure-cli-windows)
   and reopen PowerShell so `az` is on `PATH`. Use the
   [platform installer](https://learn.microsoft.com/cli/azure/install-azure-cli)
   for macOS/Linux. Neither Azure Developer CLI (`azd`) nor a Copilot login is
   needed. Install on the **orchestrator host**, not in the candidate container.
2. Obtain the existing resource name, deployment name, intended tenant UUID
   and subscription UUID from your administrator. Confirm the actual deployment's
   Responses or Anthropic Messages API, reasoning settings, resource inference
   permission and network access.
   This toolkit does not deploy models, enable identities or assign roles.
3. Sign into the intended account. This is interactive and may require MFA:

   ```powershell
   $tenantId = 'REPLACE_WITH_TENANT_UUID'
   $subscriptionId = 'REPLACE_WITH_SUBSCRIPTION_UUID'
   az version
   az login --tenant $tenantId
   $account = az account show --subscription $subscriptionId --output json | ConvertFrom-Json
   if ($LASTEXITCODE -ne 0) { throw 'The intended subscription is not available in the CLI login.' }
   if ($account.tenantId -ne $tenantId) { throw 'The selected subscription does not belong to the intended tenant.' }
   ```

   Check the returned account/tenant/subscription yourself. A subscription
   selection is not an inference grant. Use **one** token selector:
   `subscriptionId` is recommended for the intended cached subscription/account;
   `tenantId` alone explicitly selects the token tenant but still uses the
   default CLI account as the principal. The subscription-only recipe checks
   the intended tenant during setup, not as a second stored credential selector.
   No token decoding or implicit expected-tenant enforcement is claimed.

   The lockfile pins Azure Identity **4.13.3**. Its
   [`AzureCliCredential` subprocess](https://github.com/Azure/azure-sdk-for-js/blob/@azure/identity_4.13.3/sdk/identity/identity/src/credentials/azureCliCredential.ts)
   supports the two options individually, but
   [Azure CLI 2.65.0 `get_raw_token`](https://github.com/Azure/azure-cli/blob/azure-cli-2.65.0/src/azure-cli-core/azure/cli/core/_profile.py)
   rejects `--subscription` plus `--tenant`. Therefore the shared schema,
   direct credential factory and CLIs reject both-ID configurations before
   acquisition. Neither selector is silently dropped. The selected subscription
   supplies its cached tenant/account; an unavailable subscription fails, with
   no fallback to the shared default. The toolkit never runs `az account set`.
   Keep the selected CLI login stable during a campaign; if already logged in,
   check its mapping without repeating login.
   Follow [Microsoft's interactive-login guidance](https://learn.microsoft.com/cli/azure/authenticate-azure-cli-interactively)
   if browser login is unavailable (for example, its supported device-code
   flow). Do not use a username/password script or copy an access token.
4. Set the resource root in this same shell, and remove any unused key:

   ```powershell
   $env:FOUNDRY_ENDPOINT = 'https://YOUR_RESOURCE.services.ai.azure.com'
   Remove-Item Env:FOUNDRY_API_KEY -ErrorAction SilentlyContinue
   ```

   No project path, `/openai/v1`, `/anthropic`, query string or fragment belongs
   in this variable. Bash uses
   `export FOUNDRY_ENDPOINT='https://YOUR_RESOURCE.services.ai.azure.com'` and
   `unset FOUNDRY_API_KEY`. The variable is required even though login succeeded.
5. Select **both** Entra mode and the credential in configuration before
   preparation. This provider fragment is accepted by the current parser;
   replace the illustrative UUID with your subscription:

   ```json
   {
     "type": "openai",
     "wireApi": "responses",
     "auth": {
       "mode": "entra",
       "credential": "azure-cli",
       "subscriptionId": "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
       "timeoutMs": 30000
     }
   }
   ```

   Put it under `contract.foundryProvider` in a `bench` task config, or under
   **each candidate's** `foundryProvider` in campaign JSON. In the operator guide,
   `$spec.candidates[0].foundryProvider.auth` is set then mirrored into the
   task for `doctor`. Candidate configuration overrides the task's provider
   during campaign execution. Save both files as in
   [operator policy/save step](RUNNING_THE_TOOLKIT.md#3-review-finite-policy-and-calibrate-before-preparation).
   `candidate.model`/quickstart `--model` must be the exact deployment name.
   For the tenant-only alternative, replace the `subscriptionId` field with
   `"tenantId": "11111111-2222-4333-8444-555555555555"`; do not add both.
   Use `--subscription-id $subscriptionId` **or** `--tenant-id $tenantId` in
   quickstart/judge commands, never both. Omit both only when deliberately
   accepting the current CLI default account/tenant.

   Omitted auth remains key mode; merely running `az login` does not select
   keyless mode. `azure-cli` cannot take `clientId`; that option belongs to
   managed/workload identity. There is no implicit `DefaultAzureCredential`
   chain or fallback to another account, credential method or API key.

## Endpoint and token audience

Token audiences and inference roles are **endpoint-dependent**. Do not
generalize a project/agent endpoint's authentication to model inference:

| Implemented provider | Derived inference base | Current token request |
|---|---|---|
| `openai` with explicit Responses or legacy completions | `https://<resource>.openai.azure.com/openai/v1` | `https://ai.azure.com/.default` |
| `anthropic` Messages (no `wireApi` field) | `https://<resource>.services.ai.azure.com/anthropic` | The same current callback scope; deployment keyless support must be checked separately |

The current implementation in [`src/auth.ts`](../src/auth.ts) requests the
**fixed** `https://ai.azure.com/.default` scope. It does not discover an
audience from your endpoint or expose a `--scope`/JSON `scope` override.
That scope matches the
[exact pinned SDK 1.0.10-preview.0 Azure Identity guide](https://github.com/github/copilot-sdk/blob/v1.0.10-preview.0/docs/setup/azure-managed-identity.md)
and [Microsoft's v1 Responses examples](https://learn.microsoft.com/azure/foundry/openai/how-to/responses).
[Microsoft's Claude Messages examples](https://learn.microsoft.com/azure/foundry/foundry-models/how-to/use-foundry-models-claude)
also document Entra token-provider authentication with this scope. That is a
supported route, not proof that every deployment/version/runtime configuration
has been live-accepted.
Other/older Azure API examples may use `https://cognitiveservices.azure.com/.default`;
project/agent APIs have their own contracts. A deployment that requires a
different audience or lacks Entra support is **not covered by this keyless
walkthrough**. Do not invent a flag, paste a differently scoped token or
silently change auth to bypass this constraint.

Check the documentation for the **actual resource endpoint** and ask its
administrator to confirm your principal's least-privileged data-plane access:

| Endpoint family | Official resource permission reference |
|---|---|
| Azure OpenAI inference | [Cognitive Services OpenAI User and resource RBAC](https://learn.microsoft.com/azure/foundry-classic/openai/how-to/role-based-access-control) |
| Direct Foundry model inference | [Cognitive Services User and endpoint-specific Entra setup](https://learn.microsoft.com/azure/foundry/foundry-models/how-to/configure-entra-id) |

Having management **Owner/Contributor**, a project/agent role or a successful
`az login` alone is not proof of inference permission. Request the applicable
resource inference role through your organization; role propagation and
private DNS/VNet connectivity can also affect access. No role-assignment or
resource-modification commands are part of this guide.

## Deployment capacity and pacing

Before paid execution, confirm the actual resource deployment's assigned
RPM/TPM, model, SKU/region and shared traffic with its administrator. Do not
substitute subscription-wide quota, a model context limit, historic campaign
capacity or an example policy. Capacity-unit RPM/TPM ratios vary by model/SKU;
`sku.capacity` alone is not a universal token-rate conversion.

If authorized to read that resource's management metadata, this optional
**read-only network operation** uses the explicitly selected subscription;
it neither performs inference nor changes `az` defaults:

```powershell
$resourceGroup = 'REPLACE_WITH_RESOURCE_GROUP'
$resourceName = 'REPLACE_WITH_RESOURCE_NAME'
az cognitiveservices account deployment show --subscription $subscriptionId --resource-group $resourceGroup --name $resourceName --deployment-name $deployment --query '{sku:sku,model:properties.model,rateLimits:properties.rateLimits}' --output json
```

The command/arguments exist in [Azure CLI 2.65.0](https://github.com/Azure/azure-cli/blob/azure-cli-2.65.0/src/azure-cli/azure/cli/command_modules/cognitiveservices/commands.py).
Management read permission is separate from token acquisition and inference
permission. Missing/empty `rateLimits` is **unknown**, not unlimited or zero;
ask the administrator/portal for the deployment-specific values. No management
query is performed by `doctor` or this repository's offline examples.

Choose `requestBounds.requestsPerMinute` and `tokensPerMinute` within your
approved share of both limits, leaving headroom for other clients. Set them
before saving/preparing and mirror the policy for task `doctor` checks as in
[operator setup](RUNNING_THE_TOOLKIT.md#capacity-is-not-the-example-policy).
That setup attaches `foundryProvider.capacity`: an administrator declaration
or management observation with timestamp, canonical endpoint, exact deployment,
wire API and positive observed RPM/TPM. Campaign preparation and `doctor`
reject mismatched bindings or local ceilings above the observation. Actual
run admission checks the environment endpoint again before acquisition/dispatch.
Prepared state pins the observation; run identity retains only its endpoint
fingerprint. Observations can become stale and do not measure competing traffic.
Existing unbound legacy configs remain supported but capacity is `not-verified`,
not implicitly unlimited. For new paid runs, bind the reviewed observation.
The supplied policies (including 10 RPM / 200,000 TPM in the diagnostic file)
are finite **local examples**, not discovered quota or safe universal defaults.

The controller uses pessimistic input/output reservations and a rolling
one-minute window shared within one campaign process/deployment lane. It
allows requests close together until a minute bound is reached; it does not
evenly space requests, coordinate independent processes or track remaining
Azure capacity. Azure may enforce shorter RPM windows and estimated-token
TPM, so even limits below an allocation cannot certify freedom from throttling.
Billing usage is not Azure's admission estimate. If one local reservation
exceeds the chosen TPM or cannot be admitted before the finite deadline, stop;
do not inflate the TPM setting above the allocation merely to bypass a guard.

See Microsoft's [quota and rate-limit guide](https://learn.microsoft.com/azure/ai-foundry/openai/how-to/quota)
for model-dependent ratios, short-window bursts, estimated-token admission,
shared deployment limits and reset/retry headers. For a post-dispatch stream
throttle, stop the lane and review capacity/traffic with the administrator.
Allow the applicable cooldown before a separately authorized fresh attempt;
no universal cooldown duration is inferred when reset information is absent.
Changing pacing requires a new immutable cohort, not editing old prepared state.

## Initial request-fit and capacity blockers

Capacity-compatible RPM/TPM alone does not make each request admissible.
The toolkit retains its conservative **entire serialized UTF-8 request bytes
plus declared output ceiling** reservation. This includes SDK system/context
and tool schemas, not just the task prompt. It is a protective estimate,
**not** billable tokens, Azure's admission estimator or a model tokenizer.
Reasoning still shares the declared output ceiling.

After saving configuration, before paid dispatch:

```powershell
npm run doctor -- --config "$work\text-task.json" --verify-request-fit
if ($LASTEXITCODE -ne 0) { throw 'Initial request-fit blocked/unverified; no paid gate.' }
```

The actual selected SDK/CLI serializes the **unchanged initial task** using
production session options and request shaping to a bounded localhost peer.
No Entra/key acquisition, task tool, validator or model inference is performed.
The metadata-only `requestFitVerification` records runtime/backend/filter
identity, request/prompt/instructions/policy hashes, exact serialized bytes,
conservative reservation, effective output ceiling, local TPM and prospective
headroom. A blocked result exits 2. Positive initial headroom is **not**
certification of later context/tool results, relocated workspace shape or
instantaneous live/shared capacity; real requests still face admission.
Growing fixed-round context can exceed the **local** ceiling even when the
deployment observation is higher and earlier requests completed cleanly.
An admission failure with `certainty: not-dispatched`, no upstream status and
zero response bytes is a prospective local refusal, not another streamed
throttle, output exhaustion or unknown-usage request. Retain the completed
requests' meters and interrupted work-plan status. Do not auto-raise TPM or
rewrite an immutable profile: any reviewed new local ceiling must stay within
the approved deployment share, with finite cumulative tokens/requests/deadlines
and explicit shared-traffic headroom. Initial-fit proof is not a full-plan guarantee.
The probe currently supports trusted-local OpenAI Responses without MCP only.
Isolated/other-protocol shape probing is explicitly unverified, never downgraded.
Tasks requiring no terminal newline should also follow the
[exact UTF-8 editing gate](TASK_AUTHORING_GUIDE.md#exact-utf-8-editing-without-shell).
The opt-in writer adds a tool schema and changes request shape; rerun both
offline gates before immutable preparation. It does not change reasoning,
output allowance, credentials or quota automatically.

If a reservation is individually larger than the configured local TPM, the
real bridge rejects it at **zero physical dispatches**, with the reservation,
ceiling and an actionable SDK-context/request-shape explanation. Waiting,
lower concurrency or a longer deadline cannot shrink that request. A deployment
may serve the smaller actual tokenized input while this toolkit still blocks
under its deliberately conservative policy.

There is no supported model/protocol-specific tokenizer here. Owner
[tiktoken mappings](https://github.com/openai/tiktoken/blob/main/tiktoken/model.py)
are not proof that an arbitrary deployment alias uses an encoding, nor a
complete Responses framing estimate. Do not introduce bytes/4, unchecked
aliases or previous observed usage as optimistic calibration. If unchanged
SDK/default-agent context cannot fit, use sufficient assigned capacity on an
existing compatible deployment, or separately develop/review an explicit
compact context/tool profile with real coding and request-fit acceptance.
Replacing SDK system instructions is a behavioral change, not a hidden
fallback. No universally runnable low-capacity profile is claimed.
The owner [system-message types](https://github.com/github/copilot-sdk/blob/main/nodejs/src/types.ts)
explicitly warn that full replacement removes SDK-managed guardrails.
That option is not exposed as a quota workaround here. Pruning presentation
sections while preserving managed safety, repository/runtime policies and
completion instructions can still leave an individually unfit request.
Neither strategy is silently applied to make a failing profile look runnable.

## Preflight and errors

After saving the README example, run these checks separately:

```powershell
# Local checks only: no identity acquisition, no model request.
npm run doctor -- --config "$work\text-task.json"
# Optional token-only network operation: no model request, no token output.
npm run doctor -- --config "$work\text-task.json" --acquire-auth
```

`doctor` checks config, workspace access, runtime and endpoint **syntax**.
For isolated configs it also reads daemon version/local image metadata; it
does not pull/start containers or prove Linux/freezer/resource enforcement.
The token-only check exercises the selected credential and current scope.
Expect `credential-acquisition: pass` if acquisition works and
`data-plane-inference: not-verified` **even then**. A green
`localChecksPassed` is not certification of model/RBAC/network/quota behavior.

| Symptom | Action before another paid run |
|---|---|
| Credential acquisition fails | Verify CLI installation, account, tenant, interactive login/MFA or host federation setup; no fallback was attempted |
| AADSTS90072 / AADSTS50020 | Explicit CLI account/tenant mismatch; verify login and scoped tenant/subscription. The safe code is retained without account/token/error-payload details; this is not inference RBAC |
| Only one of tenant/subscription accepted | Fix the explicit choice in config/flags before token acquisition; known CLI option-conflict text is safely categorized, not replaced with full private stderr |
| 401 | Confirm deployment Entra support and token audience; token acquisition alone does not prove compatibility |
| 403 | Check endpoint-specific resource inference permission and private-network access, not just subscription/project roles |
| 404 | Check resource name, exact deployment name and selected protocol |
| 429 | Review quota/pacing/retry diagnostics; permanent quota is not transient |
| HTTP 200 then `provider_rate_limit` | Post-dispatch `rate_limit_exceeded`; review deployment capacity, shared traffic and cooldown. This is not RBAC/output exhaustion or an explicitly rejected retryable HTTP 429 |

Do not retry ambiguous dispatch simply to test permissions. Resume follows
the [recorded dispatch-certainty policy](CAMPAIGNS_AND_PUBLICATION.md#bounds-and-dispatch-certainty).
If you change auth/config/runtime, prepare a **new** campaign rather than
editing immutable state.

## Bounded terminal-failure diagnosis

An HTTP 200 stream can finish with `response.incomplete`, `response.failed`
or `error` rather than a completed task. The **first**
`runner.provider_bridge_error` retains `phase: provider-terminal` plus
`providerTerminal.eventType`, `responseStatus`, `incompleteReason`,
`errorCode`, `terminalResponse`, `usageStatus` and available numeric `usage`.
`outputTokenLimit` is the actual bridge-applied ceiling; a provider's echoed
`maxOutputTokens` is separate. Unknown categories become `other`, never raw
messages, request/response payloads, IDs or tokens.

Consistent, framed `response.incomplete` evidence with
`incompleteReason: max_output_tokens` yields `provider_output_limit` and
explicit allowance guidance. Content filtering and other terminal failures
have separate signatures. A missing terminal frame instead yields
`stream-completion`/`provider_stream_incomplete`; an upstream disconnect
remains an `upstream-body` failure with a safe network code when available.
Do not mistake a later synthetic bridge 400/session error for the first cause.
Neither a terminal incomplete nor a truncated transport is successful,
explicitly rejected or eligible for automatic replay.

An `error` or failed-response terminal carrying the categorical
`rate_limit_exceeded` yields **`provider_rate_limit`**, including after HTTP
200. It is a provider throttle signal, not evidence of output-ceiling
exhaustion, RBAC denial or which RPM/TPM window was exceeded. It remains
`possibly-processed`: completed earlier physical requests keep their captured
usage, but the throttled request's missing usage stays unknown. Neither a
`retry-after` header nor cooldown guidance makes it an explicitly rejected
request. Only the existing certified pre-processing HTTP 429 policy permits
bounded physical-request recovery; the stream error never triggers replay.

[OpenAI's Responses parameters](https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_create_params.py)
define `max_output_tokens` as **visible output plus reasoning**.
[Usage's reasoning count](https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_usage.py)
is a subset of `output_tokens`, not an extra amount to add. A small output
ceiling with high reasoning may leave no allowance for text or tool calls,
but that is only a hypothesis until terminal evidence establishes it.
The general 5,000-token examples are unchanged; they are not universal
reasoning-headroom recommendations. If the retained reason proves exhaustion,
review a larger **finite** ceiling together with reserved-token/TPM/deadline
and protective USD limits in a new cohort. Do not silently lower effort,
change the task, disable ceilings or reuse ambiguous attempts.
Use [Azure's Responses guide](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/responses)
for deployment/API compatibility; neither successful login nor a local
terminal fixture certifies the live endpoint.

For a new reader's one-cell diagnostic gate, an explicitly reviewable
[2,000-output-token profile](../examples/request-bounds.responses-diagnostic.example.json)
holds a deliberately small allowance for observing the terminal category:
10 physical requests, 1 MiB/request, 200,000 pessimistically reserved tokens,
five minutes, 10 RPM and 200,000 TPM. It does **not** promise task completion.
After operator setup/auth/execution-mode steps, **before saving/preparing**, use:

```powershell
# Fresh one-cell configuration only; never mutate a prepared campaign.
$spec.id = 'first-run-diagnostic-v1'
$diagnosticBounds = Get-Content -LiteralPath '.\examples\request-bounds.responses-diagnostic.example.json' -Raw | ConvertFrom-Json
# Preserve the already reviewed deployment pacing; the file's values are examples.
$diagnosticBounds.requestsPerMinute = $spec.requestBounds.requestsPerMinute
$diagnosticBounds.tokensPerMinute = $spec.requestBounds.tokensPerMinute
$spec.requestBounds = $diagnosticBounds
$spec.bounds.maxRequests = $spec.requestBounds.maxRequests
$spec.bounds.maxReservedTokens = $spec.requestBounds.maxTokens
$spec.bounds.maxReservationUsd = 4 # At the example's declared $20/million protective rate, not an invoice.
$task | Add-Member -NotePropertyName requestBounds -NotePropertyValue $spec.requestBounds -Force
```

Then follow the [operator save step](RUNNING_THE_TOOLKIT.md#3-review-finite-policy-and-calibrate-before-preparation)
and [first-run commands](RUNNING_THE_TOOLKIT.md#4-run-the-pre-dispatch-gates-in-order):
runtime fake gate, offline prepare, token-only doctor, and the explicitly
cost-bearing one-cell campaign run. Keep the selected CLI subscription-only
credential and declared effort unchanged. Stop at the first interruption,
grade/evidence failure or bound; do not scale.

For diagnosing an **existing** generic failure, retain its task, effort,
allowance and other bounds in a newly authorized attempt/cohort rather than
substituting this example. The minimum discriminating live gate is one fresh
cell that previously failed: record the new first categorical terminal or
transport failure and stop; if it completes, inspect files and the whole fixed
round plan. Old generic SSE errors contain no reconstructable terminal body
or usage, so the original cause remains unknown. No extra inference is
authorized by this guide.

## Cost-bearing execution

Continue with [operator first-run execution](RUNNING_THE_TOOLKIT.md#5-prepare-preview-then-deliberately-authorize-one-paid-cell)
for the bounded single-cell campaign:

```powershell
# Paid inference: state was prepared only after auth/configuration was saved.
npm run campaign -- run --directory $state --allow-paid
npm run campaign -- status --directory $state
npm run campaign -- report --directory $state --output "$work\completed-v1" --zip
```

Quickstart and the optional judge use implemented flags instead of campaign
JSON; **both invoke models immediately**, without an `--allow-paid` gate:

```powershell
npm run quickstart -- --provider openai --model $deployment --wire-api responses --auth entra --credential azure-cli --subscription-id $subscriptionId --bounds '.\examples\request-bounds.example.json' --task 'Create a string-reversal CLI with package.json test/build scripts and deterministic tests.' --output '.\.benchmark-runs\keyless-exploration-v1'
# Optional paid judge, only if explicitly wanted:
npm run evaluate -- --runs '.\.benchmark-runs\keyless-exploration-v1\artifacts' --provider openai --model 'YOUR_JUDGE_DEPLOYMENT' --wire-api responses --auth entra --credential azure-cli --subscription-id $subscriptionId --bounds '.\examples\request-bounds.example.json'
```

For key authentication choose `{"mode":"key"}`, supply `FOUNDRY_API_KEY` only
in the host process, and omit credential/tenant/subscription/client flags. The endpoint
variable is unchanged. Key-mode `doctor --acquire-auth` proves only key
presence, not validity or whether resource key authentication is enabled.

## Managed and workload identities on configured hosts

These are **alternatives** to local Azure CLI login, not a way to give Docker
Desktop an Azure identity. The orchestrator host must already support and be
configured for the identity. This repo never enables it automatically.

| Credential | Explicit auth object | Host prerequisites |
|---|---|---|
| System-assigned managed identity | `{"mode":"entra","credential":"managed-identity"}` | Identity-enabled Azure host and resource inference role for that identity |
| User-assigned managed identity | `{"mode":"entra","credential":"managed-identity","clientId":"<client-uuid>"}` | Identity attached to the supported host; explicit client ID chooses it |
| Federated workload identity | `{"mode":"entra","credential":"workload-identity","tenantId":"<tenant-uuid>","clientId":"<client-uuid>"}` | Configured federation and host-supplied, rotating `AZURE_FEDERATED_TOKEN_FILE` accessible only to the orchestrator |

Managed identity rejects `tenantId` (the Azure host owns that tenant).
`subscriptionId` is only an Azure CLI credential selector; managed/workload
identities reject it rather than silently ignoring it.
Workload identity requires explicit tenant/client IDs; a federated token file
alone is not a configured trust relationship. Host task tools/dependencies,
runtime and Linux daemon/image prerequisites still apply for isolated runs.

The refreshable experimental SDK bearer callback invokes the explicitly
selected [Azure Identity credential](https://github.com/Azure/azure-sdk-for-js/tree/main/sdk/identity/identity).
Azure Identity handles credential-specific caching/renewal; the toolkit
coalesces concurrent acquisitions and bounds their time. Keep the CLI login
valid or the host's federation file refreshed; a static JWT is not a refresh
strategy. Tokens and identity caches stay outside isolated candidate access;
**trusted-local mode does not provide that boundary**, regardless of auth mode.

Owner references:
[AzureCliCredential](https://learn.microsoft.com/javascript/api/@azure/identity/azureclicredential) |
[ManagedIdentityCredential](https://learn.microsoft.com/javascript/api/@azure/identity/managedidentitycredential) |
[WorkloadIdentityCredential](https://learn.microsoft.com/javascript/api/@azure/identity/workloadidentitycredential).
Local fake-token/SDK tests passed; live Azure tenant/RBAC/deployment behavior
has **not** been verified.
