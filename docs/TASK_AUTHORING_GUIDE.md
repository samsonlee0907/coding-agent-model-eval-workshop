# Task authoring guide

Author observable requirements, not topics. A useful task states its scope,
required behavior and edge cases, constraints, validation command, and a
definition of done. This guide is generic: it does not depend on a particular
dataset or benchmark suite.

## Quickstart tasks

Each example requires a configured Foundry environment, an existing deployment,
and a matching `--provider` (`openai` or `anthropic`). The examples below use
OpenAI; replace it only when the deployment uses the Anthropic wire shape.

`--source` is optional. When supplied, quickstart copies that clean,
secret-free starter into a new workspace and **does not modify the original**.
Use a fresh output directory for each attempt.

### 1. Small standalone task

```powershell
$model = Read-Host 'Existing OpenAI-compatible Foundry deployment name'
npm run quickstart -- --provider openai --model $model --task 'Build a TypeScript CLI named reverse-text. Accept exactly one positional string and print its Unicode code points in reverse order followed by a newline; an empty string is valid. Missing or extra arguments print usage to stderr and exit 2. Do not add a web UI, external service, or runtime dependency. Add npm tests for normal, empty, non-ASCII, and invalid arguments. Done means npm test and npm run build pass and the built CLI has the stated stdout, stderr, and exit codes.'
```

### 2. Focused regression repair

```powershell
$model = Read-Host 'Existing OpenAI-compatible Foundry deployment name'
$source = Read-Host 'Clean URL-utility starter with npm test and npm run build'
npm run quickstart -- --provider openai --model $model --source $source --task 'Fix joinUrlPath(base, segment) in the supplied TypeScript URL utility so it preserves https:// while removing only duplicate slashes at the join boundary. Preserve relative-path behavior and the public API. Do not change dependencies or unrelated utilities. Add regressions for HTTPS, boundary slashes, and relative bases. Done means npm test and npm run build pass with a focused patch.'
```

### 3. Repository feature

```powershell
$model = Read-Host 'Existing OpenAI-compatible Foundry deployment name'
$source = Read-Host 'Clean Node TypeScript API starter with npm test and npm run build'
npm run quickstart -- --provider openai --model $model --source $source --task 'Add GET /healthz to the supplied Node TypeScript API. Return HTTP 200 with application/json and body {"status":"ok"}. The handler must not mutate state or contact external services. Preserve every existing route and authentication behavior, reuse the current router, and add in-process tests for the endpoint and an unchanged route. Done means npm test and npm run build pass.'
```

## Create your first controlled evaluation

A benchmark's `workspacePath` is the **candidate's working copy**: `bench`
modifies it. Do not point it at the source repository or reuse a workspace that
contains a prior candidate's changes. Create a clean, pinned working copy for
**each candidate**, then restore or check out the pinned baseline before every
new attempt.

```powershell
Copy-Item -LiteralPath '.\benchmark.example.json' -Destination '.\benchmark.local.json'
$baseline = '<pinned-commit-sha>'
$workspace = 'C:\benchmark-workspaces\candidate-a'
git clone 'C:\path\to\prepared-starter.git' $workspace
git -C $workspace checkout --detach $baseline
git -C $workspace status --porcelain
```

Before running, replace every `REPLACE_...` value in the copied template:

1. Set the exact pinned `repository.commitSha` and an actual environment fingerprint.
2. Set provider, model, deployment, and `foundryProvider.type` consistently.
3. Set the task prompt, validation command, `workspacePath`, and
   `artifactsDirectory`.
4. Keep task, rounds, execution policy, runtime/toolchain, and validation
   identical across candidates.

Run one candidate, then create another clean checkout for the next one:

```powershell
npm run bench -- --config '.\benchmark.local.json'
npm run prices:refresh -- --runs 'C:\benchmark-artifacts'
npm run report:html -- --runs 'C:\benchmark-artifacts'
```

For `bench`, each run is written to
`<artifactsDirectory>\<run-id>`. Quickstart has a separate layout:
`.benchmark-runs\quickstart-<id>\artifacts\<run-id>`. Pass the parent directory
containing the run folders to aggregate pricing and reporting commands.

## Controlled benchmark archetypes

Use the same controlled procedure for these task shapes:

| Archetype | Requirements to state | Proof to provide |
|---|---|---|
| Library and CLI behavior | Public API, valid/invalid inputs, compatibility constraints | Unit tests and built CLI checks |
| Regression repair | Known failing behavior, preserved behavior, patch scope | Regression test plus existing suite |
| API feature | Route, response, state/external-service restrictions, compatibility | In-process request tests and build |

Keep hidden probes outside the candidate workspace. They may use independent
inputs, but must not add requirements absent from the published task.

## Custom quality evidence

`validationCommand` runs the candidate's test/build command and determines the
recorded deterministic outcome. A `conformanceProbe` is task-author-owned
behavioral evidence that runs after validation against the delivered artifact.
The optional LLM judge is a separate qualitative review; it never overrides
deterministic results.

Required and advisory conformance checks are pass/fail signals, not built-in
numeric weights: a nonzero required check is a failure, while a nonzero
advisory check is recorded as a weakness and does not decide conformance.
Custom LLM-judge dimensions and weights are not configurable through JSON
today.

This complete task fragment uses an external probe at an absolute path. The
probe must live outside the candidate workspace so it is not supplied to the
candidate:

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
        "id": "valid-duration",
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

For example, `C:\benchmark-author\probes\duration-probe.mjs` can import the
built public entry from the current working directory, assert a documented
case, and exit nonzero on failure:

```js
import assert from "node:assert/strict";
import { parseDuration } from process.cwd() + "/dist/index.js";
assert.equal(parseDuration("2s"), 2000);
```

## Publication-safe evidence

Every attempt, including failures and repeats, belongs in the archive.
`prices:refresh` discovers recorded OpenAI and/or Anthropic identities and
fetches only the matching official public pricing page. Azure model/tier/region
matches are labelled alternatives with no billing default; Claude snapshots
include both 5-minute and 1-hour cache-write scenarios.

The self-contained HTML report makes no external requests. Its replay contains
only event-specific allowlisted metadata (safe IDs, tool names, statuses, and
numeric usage/timing counters); it never embeds raw prompts, assistant
messages, tool arguments/results, or validation output.
