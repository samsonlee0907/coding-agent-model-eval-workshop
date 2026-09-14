# Task authoring guide

This guide helps you develop coding evaluation use cases that produce useful,
comparable evidence. It is about task design, not a benchmark dataset: prepare
a compatible starter yourself when a blueprint names one.

## Principles and research

Use cases should represent real engineering work while remaining small enough
to diagnose. Make success observable at the artifact boundary, test the known
failure modes, and improve the task/probe from retained failures rather than
from impressions.

- Anthropic’s [evaluation cookbook](https://github.com/anthropics/anthropic-cookbook/tree/main/evals)
  collects practical evaluation patterns.
- OpenAI’s [evaluation guidance](https://developers.openai.com/api/docs/guides/evaluation-best-practices)
  and [evaluation flywheel cookbook](https://github.com/openai/openai-cookbook/blob/main/examples/evaluation/Building_resilient_prompts_using_an_evaluation_flywheel.md)
  emphasize measuring concrete failure modes before iterating.
- Microsoft Foundry’s [evaluation guidance](https://learn.microsoft.com/azure/foundry/how-to/evaluate-generative-ai-app)
  likewise distinguishes model, agent, and dataset evaluation and supports
  automated and custom evaluators.

These are design references, not runtime dependencies or claims that this
tool implements another harness.

## Choose a supported format

| Format | Use it for | Result |
|---|---|---|
| **Simple quickstart prompt** | Exploring whether a task is clear and bounded. | One disposable local run. |
| **Detailed task file + controlled config** | Comparing candidates or repeats after requirements are fixed. | Comparable artifacts under a cohort parent. |

All quickstart examples need configured Foundry credentials, an existing
deployment, and the matching `--provider` value. Add `--source
'C:\path\to\starter'` when an existing starter is needed; it copies input and
does not alter the original. Promote a prompt to controlled mode only after its
acceptance criteria, baseline, and evaluator are stable.

## Simple quickstart prompts

These one-paragraph prompts are intentionally exploratory prototypes. Each is
copyable after replacing `$model` with an OpenAI-compatible Foundry deployment;
for an Anthropic-compatible deployment, use `--provider anthropic`.

### CSV parser regression

```powershell
$model = '<deployment-name>'
npm run quickstart -- --provider openai --model $model --task 'Build a TypeScript CSV parser with a documented parseCsv(text) API. Accept UTF-8 input with an optional BOM, CRLF or LF line endings, quoted commas, and escaped quotes. Reject unmatched quotes with a clear Error. Add focused tests for every stated case, and make npm test and npm run build pass. Do not add a dependency, network call, or unrelated feature.'
```

### TTL get-or-load cache

```powershell
$model = '<deployment-name>'
npm run quickstart -- --provider openai --model $model --task 'Build a TypeScript TTL cache exposing getOrLoad(key, loader). Concurrent requests for the same missing key must share one in-flight loader; values expire using injected or fake time; rejected loaders must not be cached. Add deterministic tests with no real sleep, and make npm test and npm run build pass. Do not add external storage, network access, or unrelated behavior.'
```

### Retry-policy repair

```powershell
$model = '<deployment-name>'
$source = Read-Host 'Clean TypeScript retry-policy starter path'
npm run quickstart -- --provider openai --model $model --source $source --task 'Repair the supplied TypeScript retry policy so only idempotent requests retry HTTP 429 and 5xx responses, Retry-After is honored when present, attempts stop at the configured limit, and authorization values are never logged. Use injected fake transport and sleeper in tests; do not use real network calls or sleeps. Preserve the public API, add focused regressions, and make npm test and npm run build pass.'
```

## Build a detailed task file

A strong `task.md` has these sections:

1. **Context and baseline** — compatible starter, immutable revision, and
   what already works.
2. **Public requirements** — observable API or CLI behavior and compatibility
   constraints.
3. **Invalid and edge cases** — explicit error and boundary behavior.
4. **Non-goals** — tempting work that must not expand scope.
5. **Visible validation** — deterministic, noninteractive command and what it
   proves.
6. **Private conformance mapping** — each hidden check maps to a public
   requirement; never turn an unstated preference into a required failure.
7. **Round plan** — initial task, then fixed review/repair follow-ups.

The task prompt is the first work request. `execution.instructions` set the
stable operating policy. `rounds[]` contain follow-up messages only; prompt
text, order, count, and `enqueue`/`immediate` mode are immutable comparison
inputs.

### Blueprint: CSV parser regression

**Context and baseline:** use a prepared TypeScript parser starter whose
`parseCsv` already handles simple comma-separated LF rows; pin its commit.

**Public requirements:** preserve `parseCsv(text)` and support BOM, LF/CRLF,
quoted commas, and escaped quotes.

**Invalid and edge cases:** unmatched quotes throw an Error; an empty record
has the documented shape.

**Non-goals:** delimiter auto-detection, streaming, and new dependencies.

**Visible validation:** `npm test && npm run build`, including public tests for
ordinary records and existing API compatibility.

**Private conformance mapping:** BOM, CRLF, quoted-comma, escaped-quote, and
unmatched-quote checks each exercise one public requirement.

**Round plan:** implement with focused tests, then review edge cases and repair
without changing the specification.

### Blueprint: stateful TTL cache

**Context and baseline:** use a prepared TypeScript cache starter with an
injectable clock.

**Public requirements:** `getOrLoad` deduplicates a simultaneous miss, expires
values at TTL, and does not cache rejected loaders.

**Invalid and edge cases:** zero TTL and loader rejection produce deterministic
behavior.

**Non-goals:** persistence, eviction policy, and background refresh.

**Visible validation:** `npm test && npm run build` using fake time.

**Private conformance mapping:** concurrent callers share one loader, expiry
reloads, and rejection reloads each map to stated behavior.

**Round plan:** implement with tests, then review races and repair without
adding requirements.

### Blueprint: configuration migration

**Context and baseline:** use a prepared CLI/config-loader starter with an old,
documented configuration shape.

**Public requirements:** migrate a named legacy key to its replacement,
preserve valid current configuration, warn on deprecated input, and write
deterministic output.

**Invalid and edge cases:** conflicting old/new values and malformed JSON
produce a nonzero exit with a clear message.

**Non-goals:** schema-framework replacement, cloud calls, and formatting
unrelated files.

**Visible validation:** `npm test && npm run build`.

**Private conformance mapping:** legacy-only, current-only, conflict, and
malformed-input checks map directly to the public requirements.

**Round plan:** implement migration/tests, then review backward compatibility
and repair.

Each blueprint needs your prepared compatible starter; it is not a turnkey
repository. The bundled [in-memory ordering scenario](../scenarios/in-memory-ordering-system/task.md)
is the runnable, full multi-round example of the same pattern.

## Connect the task file to a controlled config

Copy [`benchmark.example.json`](../benchmark.example.json), fill every
`REPLACE_...` value, and translate the public task into
`contract.task.prompt`. The following compact fragment shows the relationship;
merge it with the required execution fields in the full template.

```json
{
  "contract": {
    "task": {
      "id": "ttl-cache-v1",
      "prompt": "Implement the public requirements from the pinned TTL-cache task file.",
      "repository": {
        "commitSha": "PINNED_BASELINE_SHA",
        "containerFingerprint": "RECORDED_ENVIRONMENT_FINGERPRINT"
      },
      "validationCommand": "npm test && npm run build"
    },
    "candidate": {
      "provider": "openai",
      "model": "FOUNDRY_DEPLOYMENT_NAME",
      "deployment": "RECORDED_DEPLOYMENT_ID"
    },
    "foundryProvider": { "type": "openai" }
  },
  "rounds": [
    {
      "prompt": "Review the implementation against the stated TTL, single-flight, and rejection requirements. Run validation and repair remaining failures."
    }
  ]
}
```

`candidate.provider` and `foundryProvider.type` must be the same supported
wire shape (`openai` or `anthropic`). A round should give every candidate the
same repair opportunity, not restate the task or introduce a new requirement.

## Fairness checklist

- Use a real but bounded task with observable artifact-level acceptance cases.
- Pin one pristine baseline, compatible dependency setup, and environment
  fingerprint.
- Use a deterministic, noninteractive validator; avoid network calls and
  sleeps unless the task evaluates them deliberately.
- Keep the task prompt, instructions, ordered rounds/modes, tools, allowed
  network access, timeouts, retry policy, cache policy, and runtime fixed.
- Run every candidate and repeat in an isolated clean workspace from that
  baseline. Retain failures, rate limits, and timeouts alongside passes.
- Define whether web access or outside knowledge is permitted. If not, remove
  it consistently; if it is, make it the same for every candidate and record
  it in the contract.
- Exclude credentials, private URLs, customer data, and confidential source
  material from tasks, config, and artifacts.

## Quality evidence and scorecards

Use a scorecard with independent evidence rather than an unsupported weighted
total:

| Signal | Purpose | Decision use |
|---|---|---|
| `validationCommand` | Runs the candidate workspace’s configured deterministic gate. | Primary recorded pass/fail outcome. |
| Required conformance check | Independently exercises a public requirement. | Nonzero exit makes the conformance verdict non-conformant. |
| Advisory conformance check | Captures a useful but non-decisive preference. | Nonzero exit is **Weak**, not failure. |
| Artifact inspection | Reports inventory, exports, and applicable npm integrity checks. | Independent evidence, never an invented pass. |
| Optional fixed-rubric LLM judge | Reviews final source and provides citations. | Supplementary qualitative evidence only. |

The JSON format does not support custom numeric weights or custom judge
dimensions. Create a transparent task-owned scorecard by listing required
behaviors, independent dimensions such as maintainability or test adequacy,
and the evidence source for each. Do not let a judge override deterministic
checks.

Keep probe source outside the candidate `workspacePath`; do not disclose its
path, command, or hidden input/prompt to the candidate. The runner invokes
probe commands with the candidate workspace as its current directory. Run each
probe manually there before the cohort. For evaluator validation, prove the
baseline fails an intended repair check (and passes preserved behavior), prove
a reference implementation passes all checks, and ensure every hidden check
maps to a public requirement. Use fake time/transport and no network or real
sleeps.

## Privacy, pricing, and retention

Raw run artifacts are local-sensitive: they can contain task text, paths,
events, validator/probe output, patches, and full judge content. The
self-contained HTML report is a separate publication-oriented export with
allowlisted replay/conformance metadata and structured numeric judge data; it
makes no external requests, but is not proof that raw artifacts are shareable.

After a cohort, run `npm run portfolio -- --runs <cohort-parent>`, then
`npm run prices:refresh -- --runs <cohort-parent>`, then `npm run report:html
-- --runs <cohort-parent>`. Pricing fetches official pages only for detected
providers. Select the applicable labelled region/model scenario; Azure
alternatives are not guessed, Claude cache writes retain 5-minute and 1-hour
scenarios, and minimum published list price is an estimate rather than an
invoice. The report withholds cost ranking when contracts drift.

See the README’s [Start here](../README.md#start-here) flow and [report
guidance](../README.md#reading-a-generated-report) for the canonical commands
and interpretation.
