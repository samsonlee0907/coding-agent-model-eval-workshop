# Task authoring guide

This guide turns a coding task into comparable, publication-safe benchmark
evidence. It applies to your own repositories and task sets; it does not depend
on a particular benchmark dataset.

## Choose the right path

| Choose | When it fits | What it produces |
|---|---|---|
| `quickstart` | You want a single exploratory run or to test a task prompt against a deployment. | A copied local workspace and one run under `.benchmark-runs\quickstart-<id>\artifacts\<run-id>`. |
| Controlled `bench` | You need a repeatable comparison between candidates or attempts. | One run under `<artifactsDirectory>\<run-id>` for every clean attempt, suitable for cohort reports. |

Quickstart is not a substitute for a controlled comparison. It is useful for
shaping a task, validator, and acceptance cases before pinning them. Each
quickstart example requires a configured Foundry environment, an existing
deployment, and a matching `--provider` (`openai` or `anthropic`). The examples
below use OpenAI. When `--source` is supplied, quickstart copies the clean
starter into a new workspace and **does not modify the original**.

### Quickstart: a standalone task

```powershell
$model = Read-Host 'Existing OpenAI-compatible Foundry deployment name'
npm run quickstart -- --provider openai --model $model --task 'Build a TypeScript CLI named reverse-text. Accept exactly one positional string and print its Unicode code points in reverse order followed by a newline; an empty string is valid. Missing or extra arguments print usage to stderr and exit 2. Do not add a web UI, external service, or runtime dependency. Add npm tests for normal, empty, non-ASCII, and invalid arguments. Done means npm test and npm run build pass and the built CLI has the stated stdout, stderr, and exit codes.'
```

### Quickstart: a repair from a copied starter

```powershell
$model = Read-Host 'Existing OpenAI-compatible Foundry deployment name'
$source = Read-Host 'Clean URL-utility starter with npm test and npm run build'
npm run quickstart -- --provider openai --model $model --source $source --task 'Fix joinUrlPath(base, segment) in the supplied TypeScript URL utility so it preserves https:// while removing only duplicate slashes at the join boundary. Preserve relative-path behavior and the public API. Do not change dependencies or unrelated utilities. Add regressions for HTTPS, boundary slashes, and relative bases. Done means npm test and npm run build pass with a focused patch.'
```

### Quickstart: a repository feature

```powershell
$model = Read-Host 'Existing OpenAI-compatible Foundry deployment name'
$source = Read-Host 'Clean Node TypeScript API starter with npm test and npm run build'
npm run quickstart -- --provider openai --model $model --source $source --task 'Add GET /healthz to the supplied Node TypeScript API. Return HTTP 200 with application/json and body {"status":"ok"}. The handler must not mutate state or contact external services. Preserve every existing route and authentication behavior, reuse the current router, and add in-process tests for the endpoint and an unchanged route. Done means npm test and npm run build pass.'
```

## Task readiness checklist

Before a controlled run, confirm all of the following:

- The prompt names observable behavior, bounded scope, compatibility
  constraints, invalid/edge cases, and a definition of done.
- A single pristine source baseline is pinned by immutable commit SHA and a
  recorded environment/container fingerprint.
- Dependencies and any non-secret setup are present in that baseline or are
  described as deterministic setup commands.
- `validationCommand` is deterministic, noninteractive, offline unless the
  task explicitly requires otherwise, and exits nonzero on failure.
- Allowed tools, permitted network access, timeout, retries, and agent
  instructions are explicit and stay the same across candidates.
- Acceptance cases cover the required public behavior; use task-owned
  conformance checks for cases the candidate's own tests could miss.
- Neither the prompt, config, source baseline, validation command, nor artifacts
  contain credentials, tokens, private URLs, or sensitive customer data.

## Run a controlled multi-candidate cohort

`workspacePath` is a candidate's working copy: `bench` modifies it. Never
point it at the source baseline and never reuse a changed workspace. Give every
candidate **and every attempt** its own clean workspace and config, while
pointing every config at the same cohort `artifactsDirectory` parent.

```powershell
Copy-Item -LiteralPath '.\benchmark.example.json' -Destination '.\candidate-a-attempt-1.json'
Copy-Item -LiteralPath '.\benchmark.example.json' -Destination '.\candidate-b-attempt-1.json'

$baseline = '<pinned-commit-sha>'
$source = 'C:\benchmark-sources\prepared-starter.git'
$workspaceA = 'C:\benchmark-workspaces\candidate-a-attempt-1'
$workspaceB = 'C:\benchmark-workspaces\candidate-b-attempt-1'
$runs = 'C:\benchmark-artifacts\cohort-a'

git clone $source $workspaceA
git -C $workspaceA checkout --detach $baseline
git clone $source $workspaceB
git -C $workspaceB checkout --detach $baseline
git -C $workspaceA status --porcelain
git -C $workspaceB status --porcelain
```

In each copied config, replace every `REPLACE_...` value. Set the same task,
baseline, environment fingerprint, rounds, execution policy, validator, and
cohort `artifactsDirectory` (`$runs`); change only the recorded candidate
provider/model/deployment and that attempt's `workspacePath`. Before **every**
run, reset or check out the pinned baseline in its dedicated workspace and
confirm `git status --porcelain` is empty.

```powershell
git -C $workspaceA checkout --detach $baseline
git -C $workspaceA clean -fd
npm run bench -- --config '.\candidate-a-attempt-1.json'

git -C $workspaceB checkout --detach $baseline
git -C $workspaceB clean -fd
npm run bench -- --config '.\candidate-b-attempt-1.json'

npm run portfolio -- --runs $runs
npm run prices:refresh -- --runs $runs
npm run report:html -- --runs $runs
```

Repeat with new workspace/config names for later attempts. `bench` writes each
run to `<artifactsDirectory>\<run-id>`; the three aggregate commands discover
all `run.json` files below the one cohort parent. They write
`model-selection-report.md`, `pricing-snapshot.json`, and
`comparison-report.html` into that parent by default.

## Author the contract and rounds

Copy [`benchmark.example.json`](../benchmark.example.json) and replace every
placeholder. Its fields divide responsibility deliberately:

| Field | Purpose |
|---|---|
| `contract.task.id` | Stable task identity for joining repeated attempts. |
| `contract.task.prompt` | The public problem statement: required behavior, boundaries, and acceptance cases. The runner submits it as the initial user work request before any round. |
| `contract.task.repository` | Pinned starting commit and environment fingerprint used for comparability. |
| `contract.task.validationCommand` | The candidate workspace's deterministic acceptance gate after agent work. |
| `contract.task.conformanceProbe` | Optional task-owned independent checks after validation; see [quality evidence](#quality-evidence). |
| `contract.candidate` | Recorded provider, model, and deployment identity. |
| `contract.foundryProvider.type` | Required Foundry wire shape, exactly `openai` or `anthropic`; it must match the candidate provider. |
| `contract.execution` | Instructions, allowed tools, approval mode, concurrency, retries, timeout, streaming, cache policy, and reasoning effort. Keep it identical for comparable runs. |
| `contract.runtime` | Optional expected SDK/CLI/Node identity overrides; otherwise the runner records its installed runtime. |
| `workspacePath` | The disposable, mutable candidate copy. |
| `artifactsDirectory` | The common cohort parent; the runner creates a unique run-id subdirectory. |
| `rounds[]` | Ordered follow-up messages sent through the same agent session after the initial task. |

`task.prompt`, `execution.instructions`, and `rounds[].prompt` are different.
The runner sends the task prompt once as the first work request; it defines the
public job. Instructions set stable agent behavior, tool boundaries, and
acceptance discipline across the cohort. Rounds model additional user turns
after initial work; they should not repeat or change the task or silently add
requirements.

For example, a two-round repair task can first say **"Implement the task and
its focused tests."** and then **"Review the changes against the task, run
validation, and repair remaining failures."** This measures the same
review-and-repair opportunity for every candidate without changing acceptance
criteria.

## Quality evidence

Use complementary signals rather than collapsing them into an unsupported
score:

| Signal | What it establishes | Effect |
|---|---|---|
| `validationCommand` | The candidate's configured tests/build passed. | Anchors the recorded deterministic outcome. |
| Required conformance check | A task-owned expected behavior held against the delivered artifact. | A nonzero exit makes the conformance verdict non-conformant. |
| Advisory conformance check | A useful but non-decisive signal. | A nonzero exit records **Weak**, not failure. |
| Artifact inspection | Inventory/export facts and npm artifact-integrity checks. | Independent evidence; unavailable checks do not become passes. |
| Optional fixed-rubric LLM judge | Qualitative review of final source with verifiable citations. | Supplementary only; never overrides deterministic outcome. |

There are no built-in numeric weights, and JSON does not support custom judge
dimensions or weights today. Keep deterministic acceptance in validation and
required probe checks; use the judge to explain trade-offs, not to make hidden
requirements decisive.

### Task-owned conformance checks

A conformance probe runs in the candidate workspace after validation. Keep the
probe source **outside** that `workspacePath`, and do not reveal its path,
command, or hidden inputs/prompt to the candidate. It may exercise independent
cases but must not impose behavior missing from the public task.

```json
{
  "id": "duration-parser-v1",
  "prompt": "Implement parseDuration(text) and a CLI that accepts nonnegative integer ms, s, and m values, rejects invalid values, preserves exports, and adds focused tests.",
  "repository": {
    "commitSha": "REPLACE_WITH_PINNED_COMMIT",
    "containerFingerprint": "REPLACE_WITH_ACTUAL_ENVIRONMENT_FINGERPRINT"
  },
  "validationCommand": "npm test && npm run build",
  "conformanceProbe": {
    "description": "Independent public-artifact behavior checks.",
    "setupCommand": "npm run build",
    "timeoutMs": 60000,
    "checks": [
      {
        "id": "valid",
        "description": "The built public API accepts documented valid units.",
        "command": "node \"C:\\benchmark-author\\probes\\duration-probe.mjs\" valid",
        "severity": "required"
      },
      {
        "id": "error-message",
        "description": "Invalid input has a clear error message.",
        "command": "node \"C:\\benchmark-author\\probes\\duration-probe.mjs\" error-message",
        "severity": "advisory"
      }
    ]
  }
}
```

`C:\benchmark-author\probes\duration-probe.mjs` is an external ESM probe. The
runner executes it with the candidate workspace as its current directory, so
the dynamic import resolves the delivered `dist\index.js`:

```js
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const entry = pathToFileURL(join(process.cwd(), "dist", "index.js")).href;
const { parseDuration } = await import(entry);

switch (process.argv[2]) {
  case "valid":
    assert.equal(parseDuration("2s"), 2000);
    break;
  case "error-message":
    assert.throws(() => parseDuration("2x"), /invalid|unit/i);
    break;
  default:
    throw new Error(`Unknown probe check: ${process.argv[2] ?? "(missing)"}`);
}
```

Hand-run the same check from a prepared candidate workspace before using it in
a cohort:

```powershell
Set-Location 'C:\benchmark-workspaces\candidate-a-attempt-1'
node 'C:\benchmark-author\probes\duration-probe.mjs' valid
node 'C:\benchmark-author\probes\duration-probe.mjs' error-message
```

## Privacy, retention, and pricing

Keep raw run artifacts local and sensitive. `run.json`, raw and normalized
event logs, validation/probe output, diagnostics, patches, and copied
workspaces can contain task content, paths, or other information unsuitable for
publication. The sanitized HTML report is not proof that every raw artifact is
safe to share: it is a separate export that retains only allowlisted replay and
conformance metadata, and it makes no external requests.

Run `npm run prices:refresh -- --runs <cohort-parent>` after collecting a
cohort. It detects OpenAI and/or Anthropic candidates and fetches only the
needed official public pricing pages. Use `--region` and `--pricing-model` to
select the applicable official model/tier/region scenario. Azure alternatives
are labelled rather than guessed; Claude includes explicit 5-minute and
1-hour cache-write scenarios. The minimum published list-price ranking is
withheld when contracts drift; otherwise treat it as a scenario-specific
estimate, never an invoice or inferred billing default.

See the README's [Reading a generated report](../README.md#reading-a-generated-report)
section for how the portfolio, pricing snapshot, and HTML report support a
decision without masking failures, repeats, comparability drift, or missing
values.
