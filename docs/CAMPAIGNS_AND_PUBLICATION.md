# Campaigns and publication

This is a reusable harness, not a fixed task suite. Start with
[the compact custom campaign](../examples/custom-campaign/campaign.json);
its task/evaluator JSON files use only Node standard-library checks and public
requirements. Replace deployment placeholders and review bounds before
inference. No command provisions Azure, grants roles or merges branches.

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

## Bounds and dispatch certainty

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
pulled. Put this top-level block in each isolated task config:

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
