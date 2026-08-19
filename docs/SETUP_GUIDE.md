# Benchmark workshop setup guide

This tool runs local coding-agent benchmarks with Microsoft Foundry model
deployments through the GitHub Copilot SDK. It does not create Foundry
resources, deploy models, or store credentials.

## 1. Prepare local tools

Install:

1. Node.js 20.19 or later and npm.
2. Git, available on `PATH`.
3. A network path to npm (for installation) and the selected Foundry resource
   (for benchmark or judge requests).

The package includes an SDK runtime fallback. An installed compatible
`copilot` CLI is optional but recommended for controlled cohorts; set
`BENCHMARK_COPILOT_CLI_PATH` only when deliberately pinning that runtime.

Verify the local checkout:

```powershell
node --version
npm --version
git --version
npm ci
npm test
npm run typecheck
npm run build
```

The validation commands above are offline and do not contact a model provider.

## 2. Prepare Foundry deployments

Before a run, prepare resources in Microsoft Foundry:

1. A Foundry resource and an inference-enabled model deployment for every
   benchmark candidate.
2. A deployment for the optional LLM judge. It may be one of the candidate
   deployments, but record that choice because it can bias interpretation.
3. An API key authorized for inference. Keep its value in a secret store or
   current shell only.

Foundry uses deployment names to access models. The endpoint and deployment
requirements are documented by [Microsoft Foundry model
endpoints](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/endpoints).

## 3. Set the shell-only Foundry configuration

The workshop accepts exactly one canonical Foundry resource root:

```powershell
$env:FOUNDRY_ENDPOINT = "https://<resource-name>.services.ai.azure.com"
$env:FOUNDRY_API_KEY = "<your-foundry-api-key>"
```

Do not add project paths, `/anthropic`, `/openai/v1`, a query string, or a
fragment. The runner derives the required protocol route:

| CLI provider | Derived inference base |
|---|---|
| `openai` | `https://<resource>.openai.azure.com/openai/v1` |
| `anthropic` | `https://<resource>.services.ai.azure.com/anthropic` |

The runner stores only a SHA-256 endpoint fingerprint. It never writes the
endpoint or key to contracts, reports, diagnostics, or evaluation artifacts.

## 4. Run a candidate

Use a clean local workspace and keep the terminal open until it completes:

```powershell
npm run quickstart -- `
  --task "Build a compact TypeScript application with tests and a production build." `
  --provider openai `
  --model "<candidate-deployment-name>"
```

For a Claude deployment, change `--provider anthropic`. The default reasoning
effort is `high`; use `--reasoning-effort` only as an explicit comparison
variable. Keep source/task baseline, prompt, tool policy, timeout, reasoning
effort, validator, and adaptation policy identical across candidates.

A 404 after correct routing indicates deployment identity or availability, not
task-code quality. A missing credential fails before session creation with a
secret-safe `FOUNDRY_API_KEY` remediation message.

## 5. Review deterministic evidence

Each run creates raw/normalized events, diagnostics, `run.json`, and
`report.md` under `.benchmark-runs`. Start with:

```powershell
npm run portfolio -- --runs .benchmark-runs
```

Do not compare models as strictly comparable when the reports identify
different baseline commits, prompts, validation commands, tools, reasoning
effort, runtime versions, or wire adaptations.

## 6. Run the optional LLM judge

The judge receives only a bounded evidence packet: redacted task metadata,
contract facts, outcome, metrics, activity counts, and validator
exit/timing facts. It receives no validator command/output, credential, or raw
endpoint. It has no tools, cannot execute candidate code, and its JSON scores
are supplementary evidence.

```powershell
npm run evaluate -- `
  --runs .benchmark-runs `
  --provider openai `
  --model "<judge-deployment-name>" `
  --reasoning-effort high `
  --timeout-ms 120000
```

The output is a new `llm-evaluation-*.json` file under `.benchmark-runs`
unless `--output` is supplied. It includes the raw judge response, so retain
it under the same data policy as benchmark artifacts. Budget separately for
this request and treat malformed judge JSON as an evaluation failure, not a
candidate failure.

## 7. Make a decision responsibly

Use deterministic validation for pass/fail. Use repeated, equal-baseline runs
for time, token, and reliability conclusions. Use LLM-judge scores only to
surface review hypotheses, then confirm them with shared acceptance tests,
visual/accessibility checks where applicable, and human review for
high-impact changes.
