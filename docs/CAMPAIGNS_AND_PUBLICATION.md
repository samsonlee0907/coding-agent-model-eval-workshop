# Campaigns and publication

This is a reusable harness, not a fixed task suite. Start with
[the compact custom campaign](../examples/custom-campaign/campaign.json);
its task/evaluator JSON files use only Node standard-library checks and public
requirements. Replace deployment placeholders and review bounds before
inference. No command provisions Azure, grants roles or merges branches.

New users: follow [installation and configuration](../README.md#installation-and-configuration),
then the [single-cell first-run walkthrough](../README.md#first-run-one-task-one-deployment)
instead of assembling configuration fragments here. Docker is **not** a core
prerequisite: saved reporting, preparation and trusted-local runs work without
it. For supported keyless configuration see [Entra onboarding](KEYLESS_AUTH.md);
for the optional isolated boundary see [Docker setup and feasibility](ISOLATED_EXECUTION.md).
Preparation can pin an isolation policy offline without a daemon; actually
executing/grading it requires the Linux daemon and approved local image.

## Prepare, run, resume

`npm run campaign -- --help` lists all commands. Preparation resolves task
configurations relative to the campaign spec, and each workspace relative to
its configuration. It embeds a bounded, hashed copy of regular input files.
`.git`, `node_modules`, `.benchmark-artifacts` and `.benchmark-runs` are omitted.
Prepare dependencies in the execution image or use an explicit task setup;
do not assume a host dependency folder will appear in an isolated worker.

Task IDs must match their configurations and be unique. Candidates have stable
IDs, explicit deployment/wire shape/auth configuration, and no prescribed
model count. `repeats` are distinct declared cells, not recovery attempts.
`taskType`, title, version and tags are optional task-author metadata.
Prepared content is immutable: changed inputs, prompts, rounds, evaluators,
runtime, isolation or bounds require a new campaign/cohort. `prepared.json`
contains private task/evaluator data and is not a publication artifact.

The runtime binding records the SDK version, Node version, selected CLI's
`--version` and executable SHA-256. Selection honors
`BENCHMARK_COPILOT_CLI_PATH`, then `COPILOT_CLI_PATH`, then the installed CLI,
with the bundled executable as the fallback. A changed binding stops before
inference. The session's separately reported backend version is retained in
diagnostics; vendor backend and executable/package version labels can differ.

Before immutable preparation, run the
[README runtime coding gate](../README.md#1-check-prepare-and-preview-without-inference).
It drives real native read/create/edit or patch tools through the selected
SDK/CLI against local fake Responses, including multi-round validation and
large request bodies. For an isolated configuration, explicitly approve the
[actual worker-image gate](ISOLATED_EXECUTION.md#4-check-prerequisites-then-test-the-actual-boundary-without-inference).
No model brand determines the tool allowlist: the runtime catalog supplies
supported identifiers, and missing declared capabilities fail before physical
dispatch. The gate never adds shell to a read/edit-only contract.
Native line-patch success does not certify no-terminal-newline semantics.
For exact UTF-8 tasks, declare `execution.exactContentEdits: true` before
preparation and use the
[exact-content runtime control](TASK_AUTHORING_GUIDE.md#exact-utf-8-editing-without-shell).
Trusted-local sessions add only the bounded `custom:write_file_exact` writer
alongside native tools; isolated sessions retain worker-only exact writes,
never a host writer. The flag is immutable comparison provenance, not a
per-model repair or permission to normalize away required bytes.
Catalog discovery/initialization uses the pinned SDK's
[experimental tool RPC surface](https://github.com/github/copilot-sdk/blob/v1.0.10-preview.0/nodejs/src/generated/rpc.ts).
An SDK/CLI upgrade needs a new runtime gate and immutable cohort, not a promise
that preview tool names remain unchanged.

Progress from that gate to offline prepare/status/report, then a **bounded
one-cell paid gate**, inspecting clean completion, actual files, acceptance
grade and request accounting before scale. A no-tool READY response is not
coding acceptance. Historical monolithic worker runtimes are not a reason to
downgrade the selected CLI or put cloud credentials in the worker. This
toolkit's SDK/transport are host-owned and its isolated file tools are worker-owned.

Run/resume requires `--allow-paid`. An exclusive ownership record prevents
concurrent resume. `journal.ndjson` is append-safe authoritative state;
`state.json` is a derived convenience index. Interrupted unterminated tails
are quarantined only while holding ownership. Status/report readers never
truncate a live writer's journal.

Completed executions are not rerun because content failed. Retained
`execution.json`, exported snapshots and `run.json` support export,
validation, grading and publication recovery without inference.
Unknown dispatch without a completed checkpoint is interrupted and cannot
automatically replay. To recover an explicitly rejected-only execution:

```powershell
npm run campaign -- resume --directory '.\state' --allow-paid --recover-rejected
```

Recovery requires accounting proving that every physical request was a
transient 429 rejection (not permanent quota, auth or schema failure),
none was ambiguous, and immutable attempt/budget limits permit a new attempt.
`--recover-lock` only recovers a same-host lock whose PID is demonstrably
absent. It never steals a live process's lock. No retry-until-PASS policy exists.

### Windows grading working directories

Saved-output grading and reference calibration use short owned folders under
the operating system's temporary directory, with the existing bounded
snapshot/hash checks and cleanup on both success and error. They no longer
create `grading-input-UUID` inside a potentially long run directory. Original
outputs/references and immutable grade bindings are preserved.

Windows filesystem support for a long path does **not** imply that a child
process/shell can use it as its working directory. On the observed
Node 26.5.1 Windows host, an existing 266-character directory failed subprocess
spawn with `ENOENT`; an unhandled pipe `ENOTCONN` previously hid that first
actionable spawn failure. Shared validation now handles child and all stdio
error events with finite cleanup/output bounds and categorical diagnostics.
These are infrastructure errors, not provider failures or incorrect content.
The temp root must itself be usable by the selected shell/executable; no
registry toggle, shared defaults or automatic user-directory relocation is
performed. Task validation outside grading keeps its declared working
directory and now reports a spawn failure instead of an unhandled pipe crash.

See the owner documentation for
[Node child-process error/close events](https://nodejs.org/docs/v26.5.1/api/child_process.html#event-error),
[owned temporary directories](https://nodejs.org/docs/v26.5.1/api/fs.html#fsmkdtempsyncprefix-options)
and [Windows path limitations](https://learn.microsoft.com/en-us/windows/win32/fileio/maximum-file-path-limitation).
Retained-output resume can finish grading without new inference, but the CLI
still requires `--allow-paid`: that flag is not a grading-only guarantee for
other cells. Inspect status and the retained checkpoint before approving a
resume; do not use it to automatically continue a stopped acceptance campaign.

## Bounds and dispatch certainty

RPM/TPM values are configured local ceilings, not discovered Azure deployment
capacity. The rolling one-minute admission window permits short bursts and
cannot account for traffic outside its campaign process. Before paid execution,
review the actual deployment allocation and an approved share of both limits;
see [capacity and pacing](KEYLESS_AUTH.md#deployment-capacity-and-pacing).
A post-dispatch `rate_limit_exceeded` is diagnosed as `provider_rate_limit`,
not a certified rejected HTTP 429. It closes the lane without replay and keeps
missing usage unknown, even when prior requests completed with valid meters.
Optional per-candidate `foundryProvider.capacity` observations are immutable
endpoint/deployment/wire-bound inputs; preparation rejects over-allocation
and run admission rechecks endpoint binding. Legacy omission means unknown
capacity. The separate offline `doctor --verify-request-fit` measures the
initial SDK task request without inference/tools/grading. Individually unfit
byte-plus-output reservations fail before physical dispatch; positive initial
fit cannot certify later context growth or provider/shared headroom.
If a later reservation exceeds the local TPM bound, the request is
`not-dispatched` even if the observed deployment ceiling is larger. Earlier
completed requests remain known/metered; the unfinished task/round remains
interrupted. A newly reviewed allocation within the approved deployment share
requires a fresh finite profile/cohort, not an automatic bound increase.

Campaign bounds cover concurrency, free memory admission, absolute deadline,
attempts, requests, reserved tokens and declared USD reservations.
Request bounds cover body bytes, requests, reserved tokens, output ceiling,
RPM/TPM pacing and an absolute per-attempt deadline. Protective USD amounts use
the explicitly configured USD-per-million upper bound; they are not billing
telemetry or a guarantee of a provider invoice. Choose the bound conservatively.
Reservations persist across attempts/resumes and are not refunded as charges.
Legacy single-run calls without request bounds derive their overall ceiling
from the declared session timeout and task/round/validation/probe stage count,
not a study-specific fixed duration.
Public `quickstart` and `evaluate` CLIs now require `--bounds <file>`, parsed
by this same strict policy schema; review
[`request-bounds.example.json`](../examples/request-bounds.example.json).
`quickstart --prepare-only` prepares a disposable config/baseline without
inference, for `doctor --verify-runtime` and then cost-bearing `bench --config`.
The exported JavaScript APIs still accept omitted bounds for compatibility.
Judge requests use the same admission/output/deadline/ambiguity guard; failed
judge execution or score parsing retains a separate
`llm-evaluation-failure-*.json` with physical accounting/safe provider diagnostics
and no scores. Protective token reservations are not measured usage or money.

Token admission reserves **one token per serialized UTF-8 request byte plus
the output ceiling**, deliberately pessimistic rather than an unverified
four-characters-per-token heuristic. It is not measured usage. Bounded
inference currently accepts text-only request content; media token admission
is unsupported and fails before dispatch. Input files of other formats may
still be processed by task-owned code inside the workspace.

Only explicitly rejected transient physical 429 requests may recover.
`retry-after-ms`, Retry-After seconds/dates and bounded jittered backoff are
honored. Auth, permanent quota, malformed/nonterminal 200, partial stream and
ambiguous disconnect close the lane. A whole conversation work request is
never retried: it may already have invoked non-idempotent tools. Duplicate
possibly processed payloads cannot trigger hidden SDK replay.
SSE uses event boundaries and streaming UTF-8 decoding, not line/chunk
assumptions. Route-specific terminal evidence is certified before ending the
downstream response; partial streams are destroyed rather than extended with
JSON. Safe bridge diagnostics retain phase, upstream status, byte count and
allowlisted error code without provider payloads/credentials. Parser/lifecycle
regressions are reproduced offline; saved older transport ambiguities without
those details remain unresolved and are not automatically replayed.
Responses terminals additionally record only categorical event/status,
incomplete reason and allowlisted provider error code, plus validated usage
counters. `provider-terminal` failures are distinct from missing terminal
frames and connection loss, without widening recovery eligibility.
`requestAccounting.providerTerminals` binds each retained terminal to its
physical request, and the first bridge error retains its terminal evidence.
`ambiguousRequests` remains execution/replay uncertainty, **not** a count of
requests that must lack metering.

Where provider terminal usage is available, token metrics use its known
subtotal, including failed/incomplete responses, without adding SDK counters
again. Reasoning is already included in output tokens. Missing or invalid
usage remains unknown; cache counters and monetary costs are not invented.
SDK `modelUsageRecords`/SDK cost remain their own observations, not physical
request counts or reconstructed bills. New what-if pricing refuses unknown
physical-request spend; existing recorded estimates are never rewritten.
Metadata-safe evidence/replay exports retain these categories/counters but
never terminal messages, output, response IDs, request bodies or headers.
Older records have no retroactively inferred terminal metering. See the
[finite keyless diagnostic gate and allowance guidance](KEYLESS_AUTH.md#bounded-terminal-failure-diagnosis).
The framing reference is the owner
[SSE interpretation specification](https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation),
not a provider-specific assumption about TCP chunks.

The whole fixed task/round plan and runtime draining must finish before an
execution is completed. A crash during draining retains an interrupted
checkpoint, not a success-shaped completion.
Finalization/commands obey the active absolute deadline; per-command limits do
not reset it. Explicit resume gives retained-output finalization a fresh
bounded window, without renewing permission for ambiguous inference.
Cleanup has its own bounded window. Systemic failures stop new admission and
drain independent active lanes before releasing ownership.

## Trusted local versus credential-isolated execution

Trusted local is the compatible default. It runs candidate tools and validators
on the host, where other credentials, files, identity caches and network
resources may be reachable. It is not a sandbox. Use only trusted inputs/code
and a disposable host appropriate to that trust decision.
Host validators stop at their deadline with a bounded cleanup window and target
only the owned PID tree (Windows) or owned process group (POSIX). Deliberately
escaped descendants are not contained in trusted-local mode. Container cleanup
provides the process-namespace/freezer boundary.

Container mode requires a functioning **Linux Docker daemon** and a locally
available, immutable `repository@sha256:<64-hex-digest>` image. The image must
have `/usr/local/bin/node`, `/bin/sh`, `chmod`, and task/grader
dependencies ready for **offline** operation. Images are never automatically
pulled. Follow the [step-by-step optional isolation path](ISOLATED_EXECUTION.md)
for official installers, host/freezer feasibility, image review/digest pinning
and a no-inference owned-worker probe. Installing Docker Desktop or passing
`doctor` alone does not prove the boundary. Put this top-level block in each
isolated task config (it is a fragment, not a complete runnable task):

```json
{
  "isolation": {
    "mode": "container",
    "image": "YOUR_IMAGE@sha256:YOUR_64_HEX_DIGEST",
    "memoryMb": 1024, "cpus": 1,
    "maxFiles": 10000, "maxBytes": 67108864, "commandTimeoutMs": 60000
  }
}
```

The host SDK/orchestrator owns model authentication and transport. Candidate
sessions in empty mode expose only the custom `controlled_workspace` tool.
The toolkit injects no real credential environment, identity cache, host bind,
Docker socket, published port or host/MCP tool. They run as UID/GID 1000 with
network disabled, read-only root, dropped capabilities, no-new-privileges and
finite memory/CPU/PIDs. The image and task data remain trusted infrastructure;
containers are not a VM boundary against a malicious kernel exploit.

Use a reviewed image without baked-in credentials. An owned Docker volume
holds task files. Export seals tools, freezes all candidate processes with the
Linux freezer cgroup, and reads the volume through a separate nonroot,
read-only owned exporter. It accepts only bounded regular files with portable
paths, base64/byte/hash checks and no symlink, traversal or case collision.
Validation, legacy probes and generic evaluators run in fresh containers, not
on the host. No daemon/image failure falls back to host execution.

Owned resources have UUID-derived names and matching labels. Creation failures
attempt ownership-safe cleanup. Retained resources can be cleaned explicitly
after stopping campaign work:

```powershell
npm run campaign -- cleanup --directory '.\state' --record '.\state\runs\<run-id>\controlled-worker.json'
```

Cleanup acquires campaign ownership and checks exact names/labels. It does not
prune Docker or touch unrelated containers/volumes. Discard a worker only after
its export/recovery is no longer needed. `ControlledWorker.cleanup(recordPath)`
is also available for a standalone worker record.

## Task-owned evaluators and private assets

Each evaluator declares version, timeout/optional overall deadline and checks
with `id`, public `requirementId`, category, expected type, required/advisory
severity and a command. Commands execute **sequentially**. Exit 0 is PASS;
declared `failureExitCodes` (default `[1]`) mean FAIL or advisory WEAK.
Other exit codes, timeouts and setup failures are evaluator ERROR, not evidence
of incorrect content. Task authors must deliberately map their command's codes.
Required errors prevent acceptance; advisory errors remain visible without
overriding complete required PASS/FAIL evidence.

Grades bind run ID, execution contract, saved workspace bytes, policy hash and
version. Changed workspace bytes or incomplete/mismatched grade check sets are
rejected. Trusted-local campaign grading uses a separate hash-identical copy so
setup/check commands cannot rewrite the published candidate snapshot.

`calibrateEvaluator(policy, references, execute?)` and `verifyCalibration` are
exported APIs. Reference controls must cover positives, intentional negatives
and equivalent-valid representations for every required check, with expected
and observed results recorded. `requireCalibratedEvaluators: true` rejects a
campaign without complete matching calibration. A fabricated `calibrated: true`
flag is rejected. The examples intentionally start uncalibrated; do not infer
production validity from them.

Private files are optional and require isolated mode. Set a task's
`graderInputs` to a private directory (relative to the campaign spec) and its
evaluator's `graderInputsHash` to
`snapshotHash(collectSnapshot(directory, maxFiles, maxBytes))`. Preparation
requires disjoint candidate/private input roots and checks and embeds those bytes
separately from candidate inputs. Files are
imported only into the fresh generic grader's `/grader` tmpfs; commands can use
`node /grader/check.cjs` or another interpreter present in the pinned image.
No host-specific grader path is mapped into the worker.

For private-asset calibration, construct a fresh `ControlledWorker` for each
reference with the same grader files and use its `validate` executor. Pass
the same hash as the fourth `calibrateEvaluator` argument. `gradeSavedRun`
accepts it as its sixth argument and an optional absolute deadline seventh.
Private assets are for the generic evaluator, not automatically attached to a
legacy probe or visible validation command.

Policy revisions must be model-blind, versioned and applied uniformly to saved
outputs in a separately declared report cohort. The exported grading APIs
support saved outputs; resume does not silently replace immutable grades.
This toolkit does not regrade or alter any previously published campaign.

## Evidence, pricing and publication

`ReportEvidence` schema version 1 is shared by imported legacy runs, single-task
campaigns and multi-task campaigns. Latest clean completion is the default,
including content FAILs. Explicit pinned mappings must bind an exact completed
attempt to its declared cell and are labeled as explicit selection. Unknown
metrics stay null. Task/round/runtime/policy variants cannot masquerade as
matching evidence; task-type analysis excludes unequal comparison signatures
or incomplete graded coverage and never supplies hardcoded routing advice.

Optional campaign `pricing` pins a validated official snapshot and an explicit
scenario ID for every candidate. Recorded estimates retain snapshot hash,
retrieval time, scenario and accounting assumption. Later `prices:refresh`
produces a separate saved **what-if** snapshot; it never rewrites a run's
recorded price. Legacy report pricing details can show the explicitly supplied
what-if snapshot. There is no live-price feed, invoice estimation claim or
interactive automatic repricing of normalized campaign evidence.

By default, a report contains safe allowlisted metadata, not raw messages,
tool arguments/results, validation output, prompts, patches or workspaces.
Review user-supplied labels/IDs before sharing. To approve content, adapt
[the publication manifest](../examples/publication.example.json), bind its task
and exact output attempt, and calculate each reviewed file's SHA-256:

```powershell
(Get-FileHash -LiteralPath '.\reviewed\result.txt' -Algorithm SHA256).Hash.ToLowerInvariant()
npm run campaign -- report --directory '.\state' --output '.\reports\v2' --zip --publication '.\publication.json'
```

Roots are local approved directories; paths must be relative regular files
without traversal, symlinks or junctions. Supported routes: UTF-8 text, JSON,
CSV, inert sanitized HTML and signature-checked PNG/JPEG/GIF. HTML uses an empty
sandbox and restrictive CSP, with scripts/forms/links/styles/images removed.
PDF rendering/OCR is **unsupported**; approve a separate raster view.
`workbook-cached` is a user-supplied text/formula representation, not extraction
or recalculation. Original downloads are independently opt-in and may contain
active content; review their confidentiality and safety separately.

Preview bounds are 100 entries, 1 MiB each, 8 MiB total and 500 text lines.
Metadata replay is allowlisted and visibly missing/truncated (16 MiB archive
read and 1000 visible events per attempt). Publication is bounded to 100,000
cells/attempts, 16 MiB normalized render evidence and 64 MiB total bundle bytes;
split larger campaigns into independently identified report subsets.

Reports stage, verify selection coverage/downloads/SHA-256 files and then
publish a fresh destination. Folder/ZIP publication refuses existing targets;
it never overwrites a good report after a partial generation failure. A ZIP
failure may leave an already verified folder and returns an error. ZIP
publication uses a same-filesystem no-overwrite hard link, so an unsupported
filesystem fails explicitly. The report's `index.html` works at `file://`
without a server/CDN; JSON/CSV downloads match the folder exports.

## Acceptance boundaries and vendor references

Default tests use deidentified fixtures, fake transport/tokens/clocks and no
cloud inference. A real pinned SDK/CLI test uses a localhost Responses provider
for callback refresh, large body, multiple rounds and bridge accounting.
Offline browser tests use installed Edge on Windows, or
`BENCHMARK_BROWSER_EXECUTABLE` elsewhere; without a browser the gate is
explicitly skipped. No browser is downloaded by `npm install`.

Real Azure tenant/RBAC/deployment/key-disabled/private-network behavior and real
Docker isolation require separately authorized acceptance. Doctor distinguishes
local prerequisites, optional credential acquisition and **unverified**
data-plane inference. This implementation was validated locally without a
Docker daemon or live Azure inference; container command/export/ownership
behavior is covered with injected executors, not claimed as live verified.

- [Pinned Copilot SDK BYOK](https://github.com/github/copilot-sdk/blob/v1.0.10-preview.0/docs/auth/byok.md)
- [Pinned SDK Azure Identity callback guide](https://github.com/github/copilot-sdk/blob/v1.0.10-preview.0/docs/setup/azure-managed-identity.md)
- [Local CLI login and keyless prerequisites](KEYLESS_AUTH.md)
- [Optional Linux Docker setup and local feasibility](ISOLATED_EXECUTION.md)
- [Azure Identity JavaScript owner package](https://github.com/Azure/azure-sdk-for-js/tree/main/sdk/identity/identity)
- [Microsoft Responses authentication examples](https://learn.microsoft.com/azure/foundry/openai/how-to/responses)
- [Azure OpenAI resource RBAC](https://learn.microsoft.com/azure/foundry-classic/openai/how-to/role-based-access-control)
- [Docker container controls](https://docs.docker.com/reference/cli/docker/container/run/)
- [Docker process freezing](https://docs.docker.com/reference/cli/docker/container/pause/)
- [Docker volume filter semantics](https://docs.docker.com/reference/cli/docker/volume/ls/)
- [Windows PID-tree cleanup](https://learn.microsoft.com/windows-server/administration/windows-commands/taskkill)
- [sanitize-html owner documentation](https://github.com/apostrophecms/sanitize-html)
- [fflate owner documentation](https://github.com/101arrowz/fflate)
- [Playwright browser channels](https://playwright.dev/docs/browsers#google-chrome--microsoft-edge)
