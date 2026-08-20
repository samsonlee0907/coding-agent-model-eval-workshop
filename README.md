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
- **Honest telemetry** — metrics with no underlying event are labeled `"unavailable"`, never
  invented or estimated.
- **Paired, contract-aware comparisons** — two candidates are compared only when their run
  contracts line up; drift is flagged as "not strictly comparable" rather than hidden.
- **Self-contained reports** — HTML/Markdown output that puts efficiency and quality next to each
  other, with full raw-event artifacts for traceability.
- **Optional LLM-judge** — a clearly-labeled qualitative score for tasks where "correct" is
  subjective; never overrides the deterministic result.

## How it works

Each run moves through four stages, each owned by a focused part of the codebase:

1. **Session** (`runner.ts`) — open a streaming Copilot SDK session wired to one Foundry
   deployment, submit the task, and let the agent work naturally across multiple rounds.
2. **Capture** (`event-collector.ts`) — append every raw SDK event to an NDJSON log live
   (including streaming deltas), then normalize it into a stable data model of runs, model calls,
   tool calls, and validation results.
3. **Measure & validate** (`metrics.ts`, `validation.ts`) — derive efficiency metrics and run the
   deterministic validation command for a quality signal.
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

### Compare candidates

```bash
npm run portfolio -- --runs .benchmark-runs
```

Scans a directory of completed runs, groups paired candidates sharing the same task/run contract,
flags contract drift as "not strictly comparable", and emits an aggregate report lining up
efficiency and quality across all discovered runs. (Same command on all platforms.)

### Optional: LLM-judge quality scoring

```bash
npm run evaluate -- --runs .benchmark-runs
```

Asks a Foundry model to score two candidates' *validated artifacts* (never raw prompts or tool
transcripts) against your task's acceptance criteria. Optional and clearly labeled: it never
overrides a deterministic result, and it makes a live model call that consumes Foundry quota. See
[`docs/SETUP_GUIDE.md`](docs/SETUP_GUIDE.md).

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
| `contract.execution.tools` | The tool capabilities the agent may use. |

So **custom system-prompt instructions are fully supported today** via
`contract.execution.instructions`.

### Web search, custom skills, and MCP tools — not yet supported

The tool scope in this MVP is fixed to **`read`, `edit`, and `shell`** (mapped to the Copilot
SDK's built-in file/shell tools). The runner does **not** wire up web search, MCP servers, or
user-supplied skills/custom tools, and the example instructions deliberately steer the agent away
from the network. That means:

- A task that *requires* live internet access (web search, fetching docs) cannot be exercised
  faithfully yet.
- Your own tools/skills (via MCP or custom agents) cannot be registered for the agent to invoke,
  so you cannot benchmark a model's tool-invocation behaviour against them here.

Supporting these is a planned extension: it requires widening the `ToolCapability` model and the
session wiring (`availableTools` / `mcpServers` / `customAgents`) **and** extending the immutable
run contract and drift detection, so that enabling a tool or skill is captured as part of the
comparison and two runs with different tool access are never treated as strictly comparable. Until
that lands, keep tasks self-contained within the workspace.

## Project structure

```text
coding-agent-model-eval-workshop/
├── src/                     TypeScript source for the CLI, SDK adapter, and report engine
│   ├── runner.ts            Session/task orchestration, Foundry provider wiring, env-based credentials
│   ├── event-collector.ts   Append-only NDJSON raw-event capture + normalization to the stable data model
│   ├── metrics.ts           Derives E2E / TTFT / TPOT / tool / token / cache efficiency metrics
│   ├── outcome.ts           Classifies each run (resolved/unresolved vs. agent/infra failure classes)
│   ├── validation.ts        Runs the configured deterministic validation command and records the result
│   ├── contract.ts          Immutable run/comparison contracts + drift detection
│   ├── foundry-endpoint.ts  Derives OpenAI/Anthropic-compatible routes from a Foundry resource endpoint
│   ├── report.ts            Self-contained HTML/Markdown comparison report generation
│   ├── evaluator.ts         Optional LLM-judge scoring of two candidates' artifacts (quality signal)
│   └── quickstart.ts, portfolio.ts, cli.ts, ...  CLI entry points
├── test/                    node:test suite — fixtures/mocks only, no live SDK/network calls
├── docs/                    Setup guide, workshop exercises, and the bake-off developer journal
├── scenarios/               Example benchmark task definitions you can adapt
├── benchmark.example.json   Annotated example benchmark run configuration
└── .benchmark-runs/         Local, gitignored output directory created by your own runs
```

## Scope and limitations

This is a first working milestone, not a finished benchmark suite:

- **Provider scope**: only Foundry-hosted deployments reachable through an OpenAI- or
  Anthropic-compatible wire shape. No other providers are wired in.
- **Tooling scope**: agents get `read | edit | shell` only. Web search, MCP servers, and
  user-supplied skills/custom tools are not wired in yet — see
  [Authoring tasks, instructions, and tools](#authoring-tasks-instructions-and-tools). Custom
  system-prompt instructions, however, *are* supported.
- **Validation**: a single configured shell command runs once per candidate. No SWE-bench
  container harness yet — the contract and outcome model are designed so a future module can add
  one without breaking existing reports.
- **Cost**: reported cost reflects whatever the SDK/Foundry telemetry emits. When no priced usage
  is available, cost is `0` and explicitly labeled as such — never inferred from token counts.
- **TTFT/TPOT**: computed only when the session streamed token-level deltas; otherwise marked
  `"unavailable"`, never estimated.
- **Automated tests never make live calls**: they exercise the adapter, normalization,
  contract/drift detection, metric derivation, outcome classification, and report generation
  entirely against fixtures/mocks.

For hands-on exercises, run-contract guidance, reproducibility/fair-comparison checklists, and
responsible cost controls, see [`docs/SETUP_GUIDE.md`](docs/SETUP_GUIDE.md) and
[`docs/FOUNDRY_MODELOPS_WORKSHOP.md`](docs/FOUNDRY_MODELOPS_WORKSHOP.md). The bake-off
developer-experience journal lives in [`docs/`](docs/) alongside them.

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
