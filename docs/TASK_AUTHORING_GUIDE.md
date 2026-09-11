# Task authoring guide

Write tasks as observable behavior with a bounded scope, required edge cases,
constraints, validation commands, and a definition of done. This guide is
dataset-independent: it applies to local demonstrations and controlled cohorts.

## Three quickstart examples

Use a clean, secret-free starter when `--source` is supplied. Quickstart copies
the starter; it does not modify the original.

```powershell
$model = Read-Host 'Existing deployment name'
npm run quickstart -- --provider openai --model $model --task 'Build a TypeScript CLI named reverse-text. It accepts exactly one string, prints its Unicode code points in reverse order and a newline, and accepts an empty string. Missing or extra arguments print usage to stderr and exit 2. Do not add dependencies or a web UI. Add normal, empty, non-ASCII, and invalid-argument tests. Done means npm test and npm run build pass and the built CLI has the specified output and exit codes.'
```

```powershell
$source = Read-Host 'Clean URL-utility starter'
npm run quickstart -- --provider openai --model $model --source $source --task 'Fix joinUrlPath(base, segment) so it preserves https:// while removing only duplicate slashes at the join boundary. Preserve relative-path behavior and the public API. Do not change dependencies or unrelated utilities. Add regressions for HTTPS, boundary slashes, and relative bases. Done means npm test and npm run build pass with a focused patch.'
```

```powershell
$source = Read-Host 'Clean Node API starter'
npm run quickstart -- --provider openai --model $model --source $source --task 'Add GET /healthz to the supplied Node TypeScript API. Return HTTP 200, application/json, and {"status":"ok"}. It must not mutate state or contact external services. Preserve every existing route and authentication behavior, reuse the current router, and add in-process tests for the endpoint and an unchanged route. Done means npm test and npm run build pass.'
```

## Controlled benchmark archetypes

For comparisons, use `npm run bench -- --config .\benchmark.local.json`.
Pin the same baseline, environment fingerprint, task prompt, rounds, tool
policy, validator, and runtime for every candidate. Vary only the recorded
candidate identity unless the variation is an explicitly declared experiment.
Keep hidden probes outside the candidate workspace and never introduce hidden
requirements.

### 1. Library and CLI behavior

```json
{
  "contract": {
    "task": {
      "id": "duration-parser-v1",
      "prompt": "Implement parseDuration(text) and a CLI. Accept nonnegative integer ms, s, and m values; reject negative, fractional, empty, or unknown units with a typed error. Preserve exports and add focused tests.",
      "repository": { "commitSha": "REPLACE_PINNED_COMMIT", "containerFingerprint": "REPLACE_ENV_FINGERPRINT" },
      "validationCommand": "npm test && npm run build"
    },
    "candidate": { "provider": "openai", "model": "REPLACE_DEPLOYMENT" },
    "foundryProvider": { "type": "openai" },
    "execution": { "instructions": "Work only in the task workspace. Preserve dependency pins.", "tools": ["read", "edit", "shell"], "permissionMode": "approve-all", "concurrency": 1, "retries": 0, "sessionTimeoutMs": 900000, "streaming": true, "cachePolicy": "default", "reasoningEffort": "high" }
  },
  "rounds": [{ "prompt": "Implement the task and focused regression tests." }],
  "workspacePath": "C:\\benchmark-workspaces\\duration-parser",
  "artifactsDirectory": "C:\\benchmark-artifacts\\duration-parser"
}
```

### 2. Regression repair

Use an intentionally buggy pinned starter. State the known failure precisely,
then validate the public behavior rather than the candidate's implementation
details. The `joinUrlPath` quickstart above becomes a controlled task by
pinning the starter commit and using the same validation command for every
attempt.

### 3. API feature

Use an existing API/router and in-process tests. The health endpoint quickstart
above becomes a controlled task when each candidate starts from the same clean
commit and environment. Keep the validation command noninteractive and avoid
production requests.

## Evidence and publication

Every attempt, including failures and repeats, belongs in the archive. Generate
an offline report with:

```powershell
npm run prices:refresh -- --runs 'C:\benchmark-artifacts'
npm run report:html -- --runs 'C:\benchmark-artifacts'
```

Pricing discovers recorded OpenAI and/or Anthropic identities and fetches only
the corresponding official public price page. Azure model, tier, and region
matches are captured as labelled alternatives; no billing default is guessed.
Claude snapshots include 5-minute and 1-hour cache-write scenarios. The report
labels list-price estimates separately from provider-reported cost and billing.
