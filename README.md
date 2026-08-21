# Coding Agent Benchmark Workshop

> A TypeScript/npm toolkit for benchmarking coding models on **efficiency vs. quality** —
> running real, multi-round agent sessions and reporting what each model spends against whether
> its work actually holds up.

Choosing a model for agentic coding is a trade-off between two things usually measured apart:

- **Efficiency** — the time, round-trips, and (cached and uncached) tokens a model burns to
  finish a task.
- **Quality** — whether the result is correct: does it build, do its tests pass, does it meet the
  task's acceptance criteria?

This toolkit measures both on the *same* task under the *same* execution policy, so the two sides
can be weighed together instead of in isolation. It drives a real, persistent, streaming
[GitHub Copilot SDK](https://github.com/github/copilot-sdk) session against your own
[Microsoft Foundry](https://learn.microsoft.com/azure/ai-foundry/) model deployments, records
every SDK event, derives efficiency metrics, runs a deterministic quality check, and produces a
side-by-side comparison report.

> **Status: MVP.** This is the first module of a larger workshop. It runs real sessions and
> captures real telemetry, but its scope is deliberately narrow — see
> [Scope and limitations](#scope-and-limitations).

## Contents

- [Features](#features)
- [How it works](#how-it-works)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
- [Usage](#usage)
- [Authoring tasks, instructions, and tools](#authoring-tasks-instructions-and-tools)
- [Project structure](#project-structure)
- [Scope and limitations](#scope-and-limitations)
- [Development](#development)
- [Example run outcome](#example-run-outcome)

## Features

- **Real multi-round agent runs** — persistent, streaming Copilot SDK sessions, not single-shot
  completions. The agent plans, edits, tests, and repairs across as many rounds as it needs.
- **Efficiency metrics** — end-to-end time, time-to-first-token, time-per-output-token,
  tool/edit timings, and token/cache usage, derived from captured SDK events.
- **Deterministic quality check** — a configurable validation command (e.g. `npm test && npm run build`)
  runs after each session for an objective pass/fail signal.
- **Conformance probes** — task-authored behavioural checks run against the delivered artifact after
  validation. The agent never sees them, so passing one is evidence about the *code*, not about the
  tests the candidate chose to write. A candidate that validates green while failing a required
  expectation is reported as a divergence rather than quietly counted as a success.
- **Code artifact inspection** — every run's final workspace is measured, not just diffed: file/LOC
  inventory, export surface, and integrity checks that catch defects a *passing* test command hides
  (unresolvable manifest entry points, installed dependencies the manifest disallows, test files
  double-collected from build output). No model required.
- **Honest telemetry** — metrics with no underlying event are labeled `"unavailable"`, never
  invented or estimated.
- **Contract-aware comparisons** — two or more candidates are compared only when their run
  contracts line up; drift is flagged as "not strictly comparable" (and attributed to the
  diverging candidate) rather than hidden.
- **Self-contained reports** — HTML/Markdown output that puts efficiency and quality next to each
  other, with full raw-event artifacts for traceability.
- **Optional LLM-judge code review** — reads each candidate's *final source files* (line-numbered),
  scores seven dimensions, and returns findings that must cite `file:line`. The harness re-verifies
  every citation and badges the ones it cannot anchor. Never overrides the deterministic result.

## How it works

Each run moves through four stages, each owned by a focused part of the codebase:

1. **Session** (`runner.ts`) — open a streaming Copilot SDK session wired to one Foundry
   deployment, submit the task, and let the agent work naturally across multiple rounds.
2. **Capture** (`event-collector.ts`) — append every raw SDK event to an NDJSON log live
   (including streaming deltas), then normalize it into a stable data model of runs, model calls,
   tool calls, and validation results.
3. **Measure & validate** (`metrics.ts`, `validation.ts`, `conformance.ts`, `artifact-inspection.ts`) —
   derive efficiency metrics, run the deterministic validation command, then probe and inspect the
   delivered artifact for behaviour and defects the candidate's own test suite can hide.
4. **Compare & report** (`contract.ts`, `outcome.ts`, `report.ts`) — classify the outcome, check
   contract comparability, and emit a report that lines up efficiency and quality.

## Prerequisites

| Requirement | Version / detail | Where to get it |
|---|---|---|
| **Node.js + npm** | `^20.19.0` or `>=22.12.0` (matches the Copilot SDK's own requirement; npm ships with Node) | [nodejs.org/download](https://nodejs.org/en/download) |
| **GitHub Copilot SDK** | `@github/copilot-sdk` — pulled in automatically by `npm install`; it **bundles the Copilot CLI runtime**, so no separate install is required | [github/copilot-sdk](https://github.com/github/copilot-sdk) · [npm](https://www.npmjs.com/package/@github/copilot-sdk) |
| **Copilot CLI** *(optional)* | Only if you want to run against a newer standalone runtime than the one bundled with the SDK; point the toolkit at it via `BENCHMARK_COPILOT_CLI_PATH` or have `copilot` on your `PATH` | [GitHub Copilot CLI docs](https://docs.github.com/copilot/how-tos/set-up/install-copilot-cli) |
| **Microsoft Foundry project + deployment** | A Foundry project with at least one OpenAI- or Anthropic-compatible model deployment you can call. This toolkit does **not** provision Foundry for you. | [Create a Foundry project](https://learn.microsoft.com/azure/ai-foundry/how-to/create-projects) · [Deploy a model](https://learn.microsoft.com/azure/ai-foundry/how-to/deploy-models-managed) |
| **Foundry endpoint + API key** | The project endpoint URL and a key, supplied as environment variables (see [Configuration](#configuration)) | Foundry portal → your project → **Overview / Keys and Endpoint** |

Notes:

- **No GitHub Copilot subscription is required.** The toolkit runs the SDK with
  `useLoggedInUser: false` and authenticates model calls through your Foundry deployment
  (bring-your-own-key), so you are not signing in to Copilot.
- **No cloud resources are created by this repository.** You bring an existing Foundry
  deployment; everything else runs locally.

## Installation

**PowerShell (Windows)**
```powershell
git clone https://github.com/samsonlee0907/coding-agent-model-eval-workshop.git
cd coding-agent-model-eval-workshop
npm install
npm run build
```

**bash / zsh (Linux/macOS)**
```bash
git clone https://github.com/samsonlee0907/coding-agent-model-eval-workshop.git
cd coding-agent-model-eval-workshop
npm install
npm run build
```

`npm install` pulls the Copilot SDK (with its bundled runtime); `npm run build` compiles the
TypeScript CLI into `dist/`.

## Configuration

Provide your Foundry credentials as environment variables in the shell you run from. They are read
at run time and forwarded only to the Copilot SDK process — never written to disk or logs. A
missing or blank `FOUNDRY_API_KEY` fails fast with a shell-appropriate remediation message before
any session starts.

**PowerShell (Windows)**
```powershell
$env:FOUNDRY_ENDPOINT = "https://<your-foundry-resource>.services.ai.azure.com/api/projects/<project>"
$env:FOUNDRY_API_KEY  = "<your-foundry-api-key>"
```

**bash / zsh (Linux/macOS)**
```bash
export FOUNDRY_ENDPOINT="https://<your-foundry-resource>.services.ai.azure.com/api/projects/<project>"
export FOUNDRY_API_KEY="<your-foundry-api-key>"
```

| Variable | Required | Purpose |
|---|---|---|
| `FOUNDRY_ENDPOINT` | Yes | Your Foundry project endpoint; OpenAI/Anthropic-compatible routes are derived from it. |
| `FOUNDRY_API_KEY` | Yes | Key used to authenticate model calls to your deployment. |
| `BENCHMARK_COPILOT_CLI_PATH` | No | Path to a standalone Copilot CLI runtime to use instead of the SDK's bundled one. |

## Usage

### Run a single benchmark task

**PowerShell (Windows)**
```powershell
npm run quickstart -- --task "Build a small CLI that reverses a string." --provider openai --model "<your-deployment-name>"
```

**bash / zsh (Linux/macOS)**
```bash
npm run quickstart -- --task "Build a small CLI that reverses a string." --provider openai --model "<your-deployment-name>"
```

Opens a persistent streaming session, submits the task, lets the agent plan/edit/test/repair, runs
your validation command, and writes the raw NDJSON log, normalized run data, and a report under
`.benchmark-runs/<run-id>/`. `--provider` accepts `openai` or `anthropic` (the wire shape of your
Foundry deployment). See [`docs/SETUP_GUIDE.md`](docs/SETUP_GUIDE.md) for every flag, including
reasoning effort, timeouts, and concurrency.

### Run a bundled scenario

The [`scenarios/`](scenarios/) directory ships ready-to-adapt task definitions. Each is a
folder with a human-readable `task.md`, a `benchmark.template.json` (with prompts inlined),
and a filled-in example. The quickest way to try one is to feed its prompt to `quickstart`,
which scaffolds a throwaway workspace for you:

```bash
npm run quickstart -- \
  --task-file scenarios/in-memory-ordering-system/round1.prompt.txt \
  --provider openai --model "<your-deployment-name>"
```

For a rigorous, reproducible multi-round run, copy the scenario's
`benchmark.template.json`, fill the placeholder fields, and run it with `npm run bench --
--config <file>`. See the scenario's own `task.md` (its *How to run this scenario* section)
for details.

### Compare candidates

```bash
npm run portfolio -- --runs .benchmark-runs
```

Scans a directory of completed runs, groups candidates sharing the same task/run contract,
flags contract drift as "not strictly comparable", and emits an aggregate report lining up
efficiency and quality across every discovered candidate. (Same command on all platforms.)

### Optional: LLM-judge quality scoring

```bash
npm run evaluate -- --runs .benchmark-runs --provider openai --model "<your-judge-deployment>"
```

Asks a Foundry model to review each candidate's *delivered code* against your task's acceptance
criteria. Since `benchmark-judge-v3` the reviewer receives the artifact itself, not just a diff:

- **Every hand-authored source, test, and config file in its final state**, line-numbered as `N| code`
  so each claim can be anchored to a citation. Build output and `node_modules/` are excluded.
- **The package manifest verbatim** — small, high-signal, and never truncated.
- **The deterministic integrity results** below, supplied as established facts so the reviewer spends
  its reasoning on consequences rather than re-deriving checks the harness already performed.
- **The captured source diff** (`changes.patch`) for authorship context, and **redacted validation
  output** (test counts, failures) — never raw prompts or tool transcripts.

Secret-shaped values (URLs, `KEY=`/`token=`/`secret=` pairs) are stripped before anything reaches the
judge. The total source budget is shared across candidates, so prompts stay bounded as you add
candidates rather than growing without limit.

It scores seven dimensions (1–5): **correctness, test adequacy, API design, reproducibility,
requirement coverage, maintainability**, and overall **code quality**. Dimensions are deliberately
unweighted — a fast, small implementation and a thorough, slower one should read as different
profiles, not collapse into one number. It also returns:

- **Findings**, each citing a `file:line`. **The harness re-checks every citation** against the
  inspected artifact and marks any it cannot anchor as `unverified`, so an unchecked claim never
  reads as an established one.
- **Cross-candidate divergences** — observations that only appear when implementations are read side
  by side (for example, the same requirement handled differently across candidates). Per-run scoring
  structurally cannot produce these.
- **Reviewed files**, so review coverage is auditable against what the harness actually supplied.

When a run has no inspectable artifact the judge is told so explicitly, reports no code findings, and
lowers its confidence rather than inferring quality from timing alone. `--provider` (`openai` or
`anthropic`) and `--model` (your Foundry judge deployment) are both required, since it makes a live
model call that consumes Foundry quota. It writes an `llm-evaluation-<timestamp>.json` artifact into
the runs directory. Optional and clearly labeled: it never overrides a deterministic result. See
[`docs/SETUP_GUIDE.md`](docs/SETUP_GUIDE.md).

Each run records its diff as a `changes.patch` artifact next to `run.json`, captured non-mutating
(via a throwaway git index, so the real workspace index is untouched) and excluding build/dependency
output. The HTML report's **Code Δ** column summarizes it (files changed, insertions, deletions).

**Keeping real code in front of the judge.** Two safeguards stop generated files from crowding out
the code you actually want reviewed:

- **Lockfiles are excluded at capture time** (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`,
  `bun.lockb`, `*.lock`) alongside `node_modules/`, `dist/` and `build/`. Declared dependency ranges
  remain visible through `package.json`, which is kept.
- **Source hunks are ordered first.** Before truncating to the judge's diff budget,
  `prioritiseSourceHunks` reorders the patch so hand-authored files precede generated and
  dependency-managed ones. Without this, git's alphabetical path order lets a large lockfile consume
  the whole budget before any `src/` hunk is reached — which silently starves the judge of the code
  it is supposed to review while still appearing to succeed.

### Code artifact inspection (no model required)

Every run inspects its final workspace after validation and writes `artifact-inspection.json` beside
`run.json`. This is measured evidence, not a model opinion, and it runs whether or not you ever call
the judge. It records the file/LOC inventory and export surface, and performs three integrity checks
that a **passing test command can conceal**:

| Check | What it catches |
| --- | --- |
| **Entry-point resolution** | A manifest whose `main`/`types`/`bin`/`exports` points at a path the build never emits. The package's own tests pass by importing relative paths, but importing it by name fails. |
| **Declared-vs-installed dependencies** | A workspace validated against packages its own manifest does not allow (including pre-releases). The green result is not reproducible from that manifest. |
| **Tests collected from build output** | A test file present in both `src/` and `dist/`, which inflates a reported test count without adding a single new assertion. |

These appear in the report's **Code artifact inspection** section with a per-candidate explanation of
every flag, and roll up into an **Artifact integrity** card in the decision summary. Runs recorded
before this existed have no captured inspection; the report re-inspects their recorded workspace when
it is still on disk, and otherwise labels the artifact unavailable rather than guessing.

### Conformance probes (no model required)

Validation runs the candidate's **own** test suite, so a green result only proves the candidate agrees
with itself. A conformance probe answers the stricter question: *does the delivered artifact behave the
way the task author specified?* Declare one on the task contract:

```jsonc
"task": {
  "validationCommand": "npm test && npm run build",
  "conformanceProbe": {
    "setupCommand": "npm run build",
    "timeoutMs": 120000,
    "checks": [
      { "id": "entry-resolves",  "description": "The declared entry point exports a constructible OrderStore.",
        "command": "node \"C:\\path\\to\\scenarios\\<task>\\conformance\\probe.mjs\" entry-resolves" },
      { "id": "no-state-leak",   "description": "Mutating a returned object does not corrupt the store.",
        "severity": "advisory",
        "command": "node \"C:\\path\\to\\scenarios\\<task>\\conformance\\probe.mjs\" no-state-leak" }
    ]
  }
}
```

Each check is an independent command run in the delivered workspace **after** validation, so authoring
one needs no output protocol: **exit 0 means the expectation held**. Checks run with the benchmark's
Foundry credentials stripped from the environment, and the agent never sees them — which is what makes
a pass evidence about the *code* rather than about the tests the candidate chose to write. Commands are
run with the workspace as the working directory, so reference the probe by absolute path.

| Result | Meaning |
| --- | --- |
| **Pass** | The check exited 0. |
| **Fail** | A `required` check exited non-zero. One is enough to make the artifact non-conformant. |
| **Weak** | An `advisory` check exited non-zero — recorded and shown, but not held against the verdict. Use this for behaviour the prompt did not actually require. |
| **Error** | The check could not be executed (spawn failure or timeout). **Never counted against the artifact**; a required check that errored leaves the verdict *Inconclusive* rather than failing it. |

If `setupCommand` exits non-zero no check runs at all and every one is recorded as `error`, because an
unbuildable artifact is different evidence from a wrong one.

The probe **does not change `outcome.class`**, which stays anchored to the configured validation
command so runs recorded before probes existed remain comparable. Instead the verdict is reported
separately, and a run that validated green while failing a required expectation is called out as a
**divergence** — a red banner in the conformance section, a card in the decision summary, and a column
in the run table. Treat the conformance verdict as the stronger behavioural signal. The verdict is also
handed to the LLM judge as established fact it may not dispute.

[`scenarios/in-memory-ordering-system`](scenarios/in-memory-ordering-system) ships a worked 9-check
probe; see [its task brief](scenarios/in-memory-ordering-system/task.md#conformance-probe) for what
each check establishes.

### Generate an HTML comparison report

```bash
npm run report:html -- --runs .benchmark-runs
```

Produces a single self-contained `comparison-report.html` (no external assets) with seven parts:

1. **Decision summary** — data-derived cards naming the fastest deterministic pass, the conformance
   tally (naming any candidate that validated green while failing a required expectation), artifact
   integrity across the inspected candidates, the highest judged code quality (when an evaluation is
   attached), and the key interpretation constraint (contract drift or unpriced cost). Every figure is
   read straight from the runs, the probes, the inspections, or the judge; none is inferred.
2. **Run comparison** — every run's outcome and efficiency metrics (E2E, tokens, cache reads, cost
   multiplier, model/tool calls, TTFT, validation) plus a **Conformance** column and a **Code Δ** column
   (files changed / insertions / deletions from each run's `changes.patch`), with outcome badges and
   relative bars.
3. **Conformance probe** — a check × candidate matrix with a verdict row, a divergence banner when
   validation and conformance disagree, and the captured failure output for every non-passing check.
   Candidates whose run declared no probe read *Not probed* rather than passing by default.
4. **Code artifact inspection** — source/test file and line counts, export count, and the three
   integrity checks above, each red flag spelled out in prose beneath the table.
5. **Agent efficiency profile** — transposed (metrics as rows, candidates as columns) because you
   compare one metric across candidates, not one candidate across metrics. Covers time to first tool
   call / first edit / green test, TPOT, cache read & write tokens, cache hit share, tokens per tool
   call, and tool calls per edit. These describe *how* a candidate reached its outcome, which is what
   separates two candidates that both resolved. Nothing is estimated — a metric the stream did not
   support is marked *Unavailable* with the reason on hover. An agent that writes files through a
   shell rather than an edit tool legitimately shows *Unavailable* for the edit-derived rows.
6. **Comparability & lineage** — task ID, baseline commit, container fingerprint, reasoning effort,
   and wire adaptation per run.
7. **LLM-judge code review** (closing section) — when an `llm-evaluation-*.json` artifact is present,
   the latest one is joined by run ID and rendered as the judge's comparative read, a
   dimension × candidate score matrix, cross-candidate divergences, a severity-ordered **code
   findings** table with `file:line` citations (unresolvable citations badged `unverified`), and a
   per-candidate card carrying review coverage, the full rationale, and risks & caveats. Evaluations
   produced by an earlier prompt version are banner-flagged as having seen only a truncated diff.
   Otherwise this section explains how to produce an evaluation.

Unavailable metrics stay labeled, failures are kept in, and contract drift is flagged as *not
strictly comparable*. Override the inputs with `--output <file.html>` and `--evaluation <file.json>`.
The quality read reflects whatever the joined evaluation contains, so re-run `npm run evaluate` after
new runs to refresh the judge's scores before regenerating the report.

## Authoring tasks, instructions, and tools

**You bring the coding task.** This toolkit is the harness, not the task set — nothing is
benchmarked until you supply a task for the agent to attempt. The `--task` flag above is enough
for a quick single-prompt run, but for real benchmarks (multi-round tasks, a pinned repository
state, custom agent instructions, or a specific tool scope) author a JSON config like the
annotated [`benchmark.example.json`](benchmark.example.json) and run it with:

```bash
npm run bench -- --config ./my-task.json
```

The fields that shape what the agent does:

| Field | Purpose |
|---|---|
| `contract.task.prompt` | The task statement the agent works from. |
| `rounds[]` | One or more follow-up prompts, replayed in order, so you can model natural multi-round work (start → review/repair → …). |
| `contract.task.validationCommand` | The deterministic quality gate run after the session (e.g. `npm test && npm run build`). |
| `contract.task.repository.commitSha` | Pins the starting repo state so a comparison is reproducible. |
| `contract.execution.instructions` | The **system prompt / agent instructions** — passed straight to the SDK as the session's system message. Use this to set behaviour, constraints, and acceptance expectations. |
| `contract.execution.tools` | The tool capabilities the agent may use (`read`, `edit`, `shell`). |
| `contract.execution.mcpServers` | Optional [Model Context Protocol](https://modelcontextprotocol.io) servers to expose to the agent (e.g. a web fetch/search server or your own skills). Omit to keep the default tool scope. |

So **custom system-prompt instructions are fully supported today** via
`contract.execution.instructions`.

### Web search, custom skills, and MCP tools

The agent's default tool scope is the built-in `read | edit | shell` set. To give
it more — real web access, your own skills, or any other integration — attach one
or more **Model Context Protocol (MCP)** servers under
`contract.execution.mcpServers`. It helps to separate the three tool mechanisms the
Copilot SDK exposes:

1. **Client-side built-in tools** — run on the host (file `view`, `glob`, `edit`, and
   a `shell`/`bash` tool). This harness enables `read`, `edit`, and `shell`. **There
   is no built-in web-search or web-fetch client tool.**
2. **Your own MCP servers / custom tools** — the practical way to give the agent real
   web access (point it at a fetch/search MCP server) or to benchmark a model's
   invocation of *your* skills. **This harness now wires this in:** add servers under
   `contract.execution.mcpServers` and their tools are exposed to the agent
   automatically (`mcp:*`) alongside the built-ins. See
   [`benchmark.mcp.example.json`](benchmark.mcp.example.json) for a fetch + HTTP-search
   example.
3. **Provider-hosted server tools** — GitHub Copilot can run a hosted `web_search` on
   the model provider's side, reported through `assistant.server_tool_progress` events.
   It is **not** a client toggle — it depends on the provider/model offering it and is
   generally **not available through a custom Foundry (BYOK) provider**, which is the
   only provider this workshop uses. So in this Foundry-based workshop, mechanism #2 is
   the route for web-capable or custom-tool tasks.

**Keeping secrets out of files.** String values inside an MCP server spec (env values,
HTTP headers, args) may use `${ENV_VAR}` placeholders. The runner expands them from the
process environment at launch, so config files — and the immutable run contract — store
only the placeholder, never the resolved credential. A referenced variable that is not
set fails the run fast with a clear message.

**MCP access is part of the contract.** Configured MCP servers are folded into the
immutable run contract and drift detection: two runs with different MCP/tool access are
never treated as *strictly comparable*, so an efficiency comparison can't silently mix a
web-enabled run with a sandboxed one. Runs with **no** `mcpServers` behave exactly as
before — the default `read | edit | shell` flow is unchanged.

> Custom sub-agents and preloaded skill directories are a further SDK capability not yet
> surfaced as config here; MCP servers already cover the "give the agent a web/search or
> custom tool" case.

## Project structure

```text
coding-agent-model-eval-workshop/
├── src/                     TypeScript source for the CLI, SDK adapter, and report engine
│   ├── runner.ts            Session/task orchestration, Foundry provider wiring, env-based credentials
│   ├── event-collector.ts   Append-only NDJSON raw-event capture + normalization to the stable data model
│   ├── metrics.ts           Derives E2E / TTFT / TPOT / tool / token / cache efficiency metrics
│   ├── outcome.ts           Classifies each run (resolved/unresolved vs. agent/infra failure classes)
│   ├── validation.ts        Runs the configured deterministic validation command and records the result
│   ├── conformance.ts       Runs task-authored behavioural checks against the delivered artifact
│   ├── workspace-changes.ts Non-mutating capture of the agent's source diff vs the task baseline (changes.patch)
│   ├── artifact-inspection.ts  Final-artifact inventory, manifest/entry-point and dependency-drift integrity checks
│   ├── contract.ts          Immutable run/comparison contracts + drift detection
│   ├── foundry-endpoint.ts  Derives OpenAI/Anthropic-compatible routes from a Foundry resource endpoint
│   ├── report.ts            Per-run and paired Markdown comparison report generation
│   ├── html-report.ts       Self-contained HTML report joining run metrics with LLM-judge scores
│   ├── evaluator.ts         Optional LLM-judge review of each candidate's final code (quality signal)
│   └── quickstart.ts, portfolio.ts, cli.ts, ...  CLI entry points
├── test/                    node:test suite — fixtures/mocks only, no live SDK/network calls
├── docs/                    Setup guide (docs/SETUP_GUIDE.md)
├── scenarios/               Ready-to-adapt benchmark task definitions (see each scenario's task.md)
├── benchmark.example.json   Annotated example benchmark run configuration
├── benchmark.mcp.example.json  Example config that attaches MCP web-fetch/search tools
└── .benchmark-runs/         Local, gitignored output directory created by your own runs
```

## Scope and limitations

This is a first working milestone, not a finished benchmark suite:

- **Provider scope**: only Foundry-hosted deployments reachable through an OpenAI- or
  Anthropic-compatible wire shape. No other providers are wired in.
- **Tooling scope**: agents get `read | edit | shell` by default. You can additionally
  attach MCP servers (web fetch/search or your own skills) via
  `contract.execution.mcpServers`, and that access is captured in the run contract — see
  [Web search, custom skills, and MCP tools](#web-search-custom-skills-and-mcp-tools).
  Custom sub-agents and preloaded skill directories are not yet surfaced as config.
- **Validation**: a single configured shell command runs once per candidate. No SWE-bench
  container harness yet — the contract and outcome model are designed so a future module can add
  one without breaking existing reports.
- **Cost**: reported cost reflects whatever the SDK/Foundry telemetry emits. When no priced usage is
  available the value is `0`, which the report renders as **Unpriced** so it is never averaged with
  real figures — cost is never inferred from token counts.
- **TTFT/TPOT**: computed only when the session streamed token-level deltas; otherwise marked
  `"unavailable"`, never estimated.
- **Inspection scope**: the file/LOC inventory and export surface are language-agnostic, but the
  entry-point and dependency-drift checks read `package.json` and `node_modules`, so they only apply
  to npm/JS/TS artifacts. A non-Node artifact still gets the inventory, but those two checks
  contribute no evidence — read a clean integrity badge there as "nothing was checked", not "nothing
  is wrong".
- **Behavioural conformance**: `conformanceProbe` checks are authored per task, so a task that
  declares none gets no behavioural evidence and its candidates read *Not probed* — an honest gap, not
  a pass. A probe is only as good as the checks written for it, and it can only assert what the prompt
  actually specified; behaviour the prompt left open should be marked `advisory` so it is recorded
  without deciding the verdict. The probe also does not change `outcome.class`, which stays anchored to
  the validation command, so a divergence must be read from the conformance verdict.
- **LLM-judge scope**: the judge reads the delivered code and must cite `file:line`, and the harness
  verifies those citations — but it does not execute anything. It explains and ranks qualitatively;
  deterministic validation and inspection remain the only things that decide an outcome.
- **Automated tests never make live calls**: they exercise the adapter, normalization,
  contract/drift detection, metric derivation, outcome classification, artifact inspection, judge
  parsing/citation verification, and report generation entirely against fixtures/mocks.

For hands-on exercises, run-contract guidance, reproducibility/fair-comparison checklists, and
responsible cost controls, see [`docs/SETUP_GUIDE.md`](docs/SETUP_GUIDE.md).

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # node:test suite (fixtures/mocks, no network)
npm run build       # compile to dist/
```

The same commands work verbatim in PowerShell and bash/zsh.

## Example run outcome

Real output from three local runs — the same task and execution policy against three Foundry
deployments — shown to illustrate what a report captures. This is illustrative text from local
run artifacts, not a committed run, and contains no credentials.

Task: *"Build a html web app that shows the time now and the movement of time in a circular shape."*
Policy: streaming, high reasoning effort, concurrency 1, 900s timeout, validation `npm test && npm run build`.

| Candidate | Outcome | E2E | Model / Tool calls | Input / Output tokens | Cache-read | TTFT | TPOT | Validation |
|---|---|---|---|---|---|---|---|---|
| FW-Kimi-K3 (openai) | resolved | 374.5 s | 38 / 36 | 562,207 / 14,036 | 537,843 (95.7%) | 2.077 s | 11.934 ms | exit 0, 18 tests passing |
| GPT-5.6 Terra (openai) | resolved | 194.96 s | 12 / 14 | 200,439 / 16,920 | 128,512 (64.1%) | 2.904 s | 13.711 ms | exit 0, 4 tests passing |
| Claude Sonnet 5 (anthropic) | resolved | 420.29 s | 31 / 28 | 580,834 / 13,914 | 555,048 (95.6%) | 3.938 s | 17.651 ms | exit 0, 19 tests passing |

**Conclusion:** all three resolved, so this is a fair efficiency comparison. GPT-5.6 Terra was
roughly 2× faster and used far fewer tokens, but wrote the fewest tests — the classic
efficiency-vs-thoroughness trade-off this toolkit exists to make visible. Which model is "best"
depends on your quality bar, not the token count alone. (Cost is absent because these deployments
emitted no priced telemetry — a labeled gap, not a claim of $0.)
