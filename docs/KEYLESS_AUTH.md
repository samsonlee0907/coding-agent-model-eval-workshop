# Keyless Microsoft Entra authentication

Start with the [README first-run walkthrough](../README.md#first-run-one-task-one-deployment).
It includes the actual example, saving configuration, offline preview and paid
run/report commands. This guide explains the authentication steps and boundaries
in more detail. Docker is unrelated to choosing key versus keyless authentication.

## Local developer setup

1. Install [Azure CLI on Windows](https://learn.microsoft.com/cli/azure/install-azure-cli-windows)
   and reopen PowerShell so `az` is on `PATH`. Use the
   [platform installer](https://learn.microsoft.com/cli/azure/install-azure-cli)
   for macOS/Linux. Neither Azure Developer CLI (`azd`) nor a Copilot login is
   needed. Install on the **orchestrator host**, not in the candidate container.
2. Obtain the existing resource name, deployment name, intended tenant UUID
   and subscription UUID from your administrator. Confirm deployment Responses
   support, reasoning settings, resource inference permission and network access.
   This toolkit does not deploy models, enable identities or assign roles.
3. Sign into the intended account. This is interactive and may require MFA:

   ```powershell
   $tenantId = 'REPLACE_WITH_TENANT_UUID'
   $subscriptionId = 'REPLACE_WITH_SUBSCRIPTION_UUID'
   az version
   az login --tenant $tenantId
   az account set --subscription $subscriptionId
   az account show --query '{tenant:tenantId,subscription:id,user:user.name}' --output json
   ```

   Check the returned account/tenant/subscription yourself. A subscription
   selection is CLI context, not a new inference grant and not an auth field
   in campaign JSON. `AzureCliCredential` uses the signed-in CLI account in
   the selected tenant; do not change that account during a campaign.
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
   replace the illustrative UUID with your tenant:

   ```json
   {
     "type": "openai",
     "wireApi": "responses",
     "auth": {
       "mode": "entra",
       "credential": "azure-cli",
       "tenantId": "11111111-2222-4333-8444-555555555555",
       "timeoutMs": 30000
     }
   }
   ```

   Put it under `contract.foundryProvider` in a `bench` task config, or under
   **each candidate's** `foundryProvider` in campaign JSON. In the README,
   `$spec.candidates[0].foundryProvider.auth` is set then mirrored into the
   task for `doctor`. Candidate configuration overrides the task's provider
   during campaign execution. Save both files as in README step 4.
   `candidate.model`/quickstart `--model` must be the exact deployment name.

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
| 401 | Confirm deployment Entra support and token audience; token acquisition alone does not prove compatibility |
| 403 | Check endpoint-specific resource inference permission and private-network access, not just subscription/project roles |
| 404 | Check resource name, exact deployment name and selected protocol |
| 429 | Review quota/pacing/retry diagnostics; permanent quota is not transient |

Do not retry ambiguous dispatch simply to test permissions. Resume follows
the [recorded dispatch-certainty policy](CAMPAIGNS_AND_PUBLICATION.md#bounds-and-dispatch-certainty).
If you change auth/config/runtime, prepare a **new** campaign rather than
editing immutable state.

## Cost-bearing execution

Continue with README step 5 for the bounded single-cell campaign:

```powershell
# Paid inference: state was prepared only after auth/configuration was saved.
npm run campaign -- run --directory $state --allow-paid
npm run campaign -- status --directory $state
npm run campaign -- report --directory $state --output "$work\completed-v1" --zip
```

Quickstart and the optional judge use implemented flags instead of campaign
JSON; **both invoke models immediately**, without an `--allow-paid` gate:

```powershell
npm run quickstart -- --provider openai --model $deployment --wire-api responses --auth entra --credential azure-cli --tenant-id $tenantId --task 'Create a string-reversal CLI with package.json test/build scripts and deterministic tests.' --output '.\.benchmark-runs\keyless-exploration-v1'
# Optional paid judge, only if explicitly wanted:
npm run evaluate -- --runs '.\.benchmark-runs\keyless-exploration-v1\artifacts' --provider openai --model 'YOUR_JUDGE_DEPLOYMENT' --wire-api responses --auth entra --credential azure-cli --tenant-id $tenantId
```

For key authentication choose `{"mode":"key"}`, supply `FOUNDRY_API_KEY` only
in the host process, and omit credential/tenant/client flags. The endpoint
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
