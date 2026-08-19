# Microsoft Foundry ModelOps Workshop

This workshop compares Microsoft Foundry deployments while holding the
multi-round GitHub Copilot SDK agent, task baseline, prompt, tool profile,
timeouts, and deterministic evaluator constant. It is not a generic provider
or external-gateway client.

## Start a local benchmark

```powershell
npm ci
npm run build

$env:FOUNDRY_ENDPOINT = "https://<resource-name>.services.ai.azure.com"
$env:FOUNDRY_API_KEY = "set-this-only-in-your-shell"

npm run quickstart -- `
  --task-file C:\tasks\coding-task.md `
  --provider openai `
  --model "gpt-5.6-terra"
```

Use `--provider anthropic --model "<deployment-name>"` for a Claude
deployment. These are the only accepted provider values. The runner defaults
to `high` reasoning effort; add `--reasoning-effort low|medium|high|xhigh|max`
only when that is an explicit comparison variable.

The resource endpoint must be exactly
`https://<resource-name>.services.ai.azure.com`. It cannot be an OpenAI host,
a project endpoint, a path-suffixed endpoint, or an endpoint with credentials,
query, or fragment. The runner derives:

| Provider | Derived SDK base |
|---|---|
| `openai` | `https://<resource>.openai.azure.com/openai/v1` |
| `anthropic` | `https://<resource>.services.ai.azure.com/anthropic` |

This follows [Microsoft Foundry model endpoints](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/endpoints).
Use the supplied deployment/model ID verbatim. A 404 after correct routing is
deployment-identity or availability evidence, not a task-code or validator
result. For models where Responses is unsupported, use the compatible Chat
Completions route selected by this runner for `openai`.

## Compatibility disclosure

The contract and report retain only a SHA-256 fingerprint of the derived
endpoint. They also disclose the local wire adaptation because runs with
different wire behavior are not strictly comparable:

| Provider | Adaptation | Purpose |
|---|---|---|
| `anthropic` | `strip-temperature` | Removes the deprecated `temperature` property from Foundry Anthropic requests. |
| `openai` | `openai-null-refusal-sanitizer` | Removes only `refusal: null` from every outbound `messages[]` continuation array. |

The OpenAI sanitizer is loopback-only and preserves headers/authentication,
non-null `refusal` values, and every other request field. It addresses the
observed FW-Kimi-K3 second-turn rejection:
`400 Extra inputs are not permitted, field: 'messages[2].refusal', value: None`.
It does not alter Anthropic payloads. Proxy-forwarding failures surface as
harness errors and the proxy closes with the run.

## Optional LLM quality judge

Run deterministic validation first. When qualitative review is useful, run the
separate `evaluate` command over completed `run.json` artifacts:

```powershell
npm run evaluate -- `
  --runs .benchmark-runs `
  --provider openai `
  --model "<judge-deployment-name>"
```

The judge uses the same canonical `FOUNDRY_ENDPOINT` and `FOUNDRY_API_KEY`
configuration as a candidate. It starts a separate, tool-free Copilot SDK
session using the selected Foundry judge deployment. The evidence packet is
bounded and explicitly treated as untrusted data so task text cannot redirect
the judge's instructions; validator commands and output are excluded. The result contains one
1–5 evidence-based score per candidate, confidence, rationale, risks,
limitations, judge identity, request adaptation, and raw response.

Judge output is supplementary. It cannot prove a build, test, visual behavior,
security property, or cost. A malformed judge response fails evaluation only;
it never changes a candidate's deterministic benchmark outcome. Budget for
the judge request and treat the resulting JSON as restricted artifact data.

## Evidence and fair comparison

1. Create one local baseline and use fresh copies for all candidates.
2. Pin task prompt/rounds, validation command, tools, timeout, reasoning effort,
   runtime versions, and environment fingerprint.
3. Keep raw and normalized events, validation command/stdout/stderr, and report.
4. Include resolved, unresolved, timeout, rate-limit, empty-patch, tool, and
   harness failures in the report; do not silently filter them.
5. Compare cost, tokens, TTFT/TPOT, and cache fields only when runtime events
   supply them. Reports label unavailable metrics rather than estimating them.
6. Treat model/deployment/protocol/adaptation drift as non-comparable unless a
   decision explicitly accepts the difference.

## Scope and limitations

The current MVP runs local workspaces and deterministic validation. It neither
creates cloud resources nor discovers deployments, prices, quota, or capacity.
Use Foundry deployment management separately to prepare an approved candidate
set. Add SWE-bench/container adapters only as later task modules; they are not
downloaded or provisioned here.
