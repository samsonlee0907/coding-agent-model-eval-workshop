# Microsoft Foundry ModelOps routing workshop

## Start a local benchmark

The toolkit uses the GitHub Copilot SDK as the persistent coding-agent runtime.
It does not require a GitHub repository for a first run. Provide a task,
optional source artifact, and non-secret references to your model endpoint and
credential environment variables:

```powershell
$env:MODEL_BASE_URL = "https://your-provider-endpoint"
$env:MODEL_API_KEY = "set-this-only-in-your-shell"

npm run quickstart -- `
  --task "Build a compact TypeScript application with tests and a production build." `
  --provider "foundry-openai" `
  --provider-type "openai" `
  --model "your-foundry-deployment-name"
```

The quickstart command creates a local-only task workspace, copies an optional
`--source` artifact, initializes a local Git baseline, derives the baseline SHA
and environment fingerprint, runs two persistent agent turns, detects test and
build scripts after implementation, then writes artifacts under
`.benchmark-runs/`. It creates no GitHub remote and stores no secret value.

### Candidate connection profiles

The `--provider-type` reflects the endpoint protocol—not a model brand. Verify
the deployment's supported protocol in the Foundry catalog/deployment
documentation before a benchmark.

| Candidate endpoint | `--provider-type` | Important settings |
|---|---|---|
| Foundry OpenAI-compatible `/openai/v1/` endpoint | `openai` | Use the deployment name as `--model`; use `--wire-api responses` only when the endpoint/model supports Responses API, otherwise `completions`. |
| Native Azure OpenAI endpoint | `azure` | `MODEL_BASE_URL` is the host only; pass `--wire-api` only if the protocol supports it. Extend the config for the required Azure API version before using a versioned deployment. |
| Direct Anthropic Messages API | `anthropic` | Use the Claude model ID and do **not** set `--wire-api`; the SDK uses the Anthropic Messages API. |
| Anthropic model exposed by Foundry | depends on Foundry endpoint | Use the protocol the Foundry deployment exposes. Do not assume a Foundry-hosted Claude deployment accepts direct Anthropic Messages API; confirm the deployment's endpoint/authentication details. |
| External OpenAI-compatible model gateway | `openai` | Record provider/region/deployment separately; use `completions` unless Responses API is confirmed. |

For an Anthropic-compatible endpoint:

```powershell
$env:FOUNDRY_ANTHROPIC_BASE_URL = "https://your-confirmed-anthropic-compatible-endpoint"
$env:FOUNDRY_ANTHROPIC_API_KEY = "set-this-only-in-your-shell"

npm run quickstart -- `
  --task-file C:\tasks\coding-task.md `
  --provider "foundry-anthropic" `
  --provider-type "anthropic" `
  --model "your-confirmed-claude-model-id" `
  --base-url-env FOUNDRY_ANTHROPIC_BASE_URL `
  --api-key-env FOUNDRY_ANTHROPIC_API_KEY
```

For a strict comparison, generate one local baseline, retain it, and create a
fresh copy for each candidate. Never compare outputs generated from different
starter states, tool profiles, prompts, validation, or environment
fingerprints.

## Outcome

Produce a versioned **coding-task router policy**, not a claim that one model
is universally best. The policy assigns eligible models to task classes and
defines fallback, budget, quality, latency, data-residency, and tool-compatibility
constraints.

The current benchmark runner is the controlled coding-agent harness. Microsoft
Foundry supplies model discovery, deployment/capacity governance, evaluation,
monitoring, and—when appropriate—agent tools. Keep the agent runtime and tool
profile constant while comparing models.

## Scope

| In scope | Out of scope for the first workshop |
|---|---|
| Discover models/deployments currently available to the selected Foundry project and region. | Declaring a static global “best model” list. |
| Compare a small candidate portfolio on pinned, reproducible coding tasks. | Comparing models that received different prompts, tools, task state, or validation. |
| Create a routing table with quality, latency, cost, availability, and fallback thresholds. | Fine-tuning models before a baseline routing policy exists. |
| Validate deterministic code outcomes first; use quality/safety evaluators as secondary signals. | Treating an LLM judge as proof that a repository builds or tests pass. |
| Pilot, monitor, and revise routing decisions with versioned evidence. | Enabling production auto-routing without a canary or rollback path. |

## Recommended workshop flow

### 1. Inventory: catalog, deployment, and constraints

For the selected Azure subscription, Foundry project, and region:

1. Query the Foundry model catalog and current deployments dynamically. Model
   availability, region support, SKUs, quota, and tool compatibility change, so
   do not bake an online list into the workshop.
2. Record candidate model/deployment identity, provider, version, region,
   endpoint class, pricing basis, capacity/quota, context limit, and supported
   request/tool features.
3. Include only candidates that can meet the task's data-residency, safety, and
   latency requirements. Preserve rejected candidates and the reason.
4. Deploy only the short list needed for the workshop. Use serverless or
   low-capacity development deployments first; assess provisioned throughput
   only after demand and latency targets are understood.

Foundry deployment selection must validate actual catalog SKU support and
available subscription quota before candidates are chosen.

### 2. Define task and tool families

Start with 12–20 tasks across these coding-agent classes:

| Task family | Example | Primary deterministic evaluator |
|---|---|---|
| Greenfield feature | Build a small TypeScript application from a brief. | Build plus behavior tests. |
| Targeted bug fix | Repair a failing regression in an existing service. | Original regression test plus full targeted suite. |
| Multi-file refactor | Introduce a typed API while preserving behavior. | Typecheck, tests, public API contract. |
| Test/repair loop | Diagnose a seeded failing test and repair it. | Test becomes green without changing its expected behavior. |
| Long-context change | Use a supplied design artifact across multiple files. | Architectural checks plus behavior tests. |
| Security/reliability hardening | Fix a seeded validation/error-handling defect. | Negative tests and static/security checks. |

Run each family through fixed **tool profiles**. The first profile should use
only the local coding-agent tools needed for file read, edit, and shell/test
execution. Evaluate Foundry Agent Service tools—such as Code Interpreter,
function calling, MCP, file search, or web/search tools—in separate
experiments; otherwise tool differences are incorrectly attributed to the
model.

### 3. Establish the baseline

Use `npm run quickstart` for an initial from-scratch task. It creates a
local-only baseline and metadata automatically; no GitHub repository is needed.
For paired comparisons, reuse copies of the **same generated baseline** for
every candidate.

For each run, preserve:

- task prompt/rounds, optional source artifact fingerprint, local baseline SHA,
  dependency/environment fingerprint, tool profile, timeout, retry and cache
  policy;
- model/deployment/provider identity and region;
- raw events, normalized events, validation record, run report, and provider
  billing export where applicable.

### 4. Score all runs before ranking

Gate routing eligibility on deterministic correctness first:

```text
eligible = validation pass rate >= task-family threshold
           AND no unresolved safety/compliance blocker
           AND deployment is available within the required region
```

For eligible candidates report:

- resolved rate and unresolved/failure breakdown;
- cost **per resolved task**, not only average cost;
- median and p95 E2E time, time to first tool/edit/green validation;
- token/cache/cost fields only when emitted by the runtime or provider;
- tool failure rate, timeout/rate-limit rate, and repair-turn count;
- task-family performance rather than one global aggregate.

Use Foundry quality/safety evaluators as secondary diagnostic signals. Keep
their evaluator version, rubric, dataset version, and judge model alongside
the deterministic result.

### 5. Produce the initial router

Create an explicit table such as:

| Task class | Primary route | Fallback | Entry gate | Exit/fallback trigger |
|---|---|---|---|---|
| Small greenfield UI | lowest-cost candidate that meets quality threshold | balanced coding model | low complexity, no sensitive artifact | validation fails or time budget exceeded |
| Standard bug fix/refactor | balanced coding model | strongest coding/reasoning model | normal context/tool needs | first repair turn fails or evaluator risk threshold exceeded |
| Long-context/high-risk change | strongest eligible model | human escalation | large artifact, high blast radius | missing evidence, timeout, or safety gate |

Keep the routing policy in version control with the benchmark report IDs that
support it. A router should select only among deployments it has verified as
available; it needs a capacity/rate-limit fallback and a human-escalation
route.

### 6. Pilot and monitor

Use shadow routing first: log the route a policy *would* select while retaining
the existing production route. Then run a limited canary with rollback rules.
Continuously evaluate task-family regressions, routing drift, deployment
availability, cost per resolved task, and safety signals. Re-benchmark after a
model version, deployment, tool profile, prompt, or task-suite change.

## Prerequisites

### Governance and access

- A named workshop owner for task definitions, evaluation policy, deployment,
  cost approval, and routing sign-off.
- Azure subscription, selected Foundry project/region, and access to the model
  catalog and relevant deployments.
- Permissions to view quota/capacity and deploy only the approved candidates.
- Approved budget, rate limits, data classification, retention policy, and
  incident/rollback owner.
- Credential approach: API key or Microsoft Entra authentication for Foundry;
  secret values remain in the shell/secret store, never task config or event
  artifacts.

### Technical baseline

- Node.js, npm, Git, and an isolated local task workspace; Docker is optional
  but recommended once tasks need a common Linux/container runtime.
- The Copilot SDK benchmark runner, fixed tool profile, and a deterministic
  validation command for every task.
- A provider adapter per candidate. The SDK supports `openai`, `azure`, and
  `anthropic` provider protocols. Select based on the deployment's documented
  endpoint protocol; record Foundry-hosted and external candidates separately
  for billing and operational ownership.
- An artifact store with restricted access for raw prompts, responses, tool
  arguments, and test output.

### Evaluation readiness

- Task suite split into smoke, regression, and coverage tiers. Begin with
  smoke runs before broader comparisons.
- Deterministic evaluators for code correctness plus separate rubric/safety
  evaluators where they add information.
- A model/deployment manifest that records region, version, quota, context,
  supported tool/request features, and price source.
- A rule for unavailable metrics: mark unavailable; never substitute estimates.

## Workshop deliverables

1. Candidate inventory and deployment/capacity manifest.
2. Versioned coding-task suite, source artifacts, deterministic evaluators, and
   tool-profile compatibility matrix.
3. Raw benchmark artifacts and all-run comparison report.
4. Task-family Pareto analysis: quality, latency, cost, resilience.
5. Router policy, fallback/escalation rules, and change-control owner.
6. Pilot/continuous-evaluation dashboard and regression thresholds.

## Official references

- [Foundry model deployment and capacity guidance](https://learn.microsoft.com/azure/foundry/openai/how-to/provisioned-get-started)
- [Microsoft Foundry toolbox](https://learn.microsoft.com/azure/foundry/agents/how-to/tools/toolbox)
- [GitHub Copilot SDK BYOK configuration](https://github.com/github/copilot-sdk/blob/main/docs/auth/byok.md)
