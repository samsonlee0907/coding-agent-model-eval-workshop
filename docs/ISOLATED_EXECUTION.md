# Docker isolation: optional, fail-closed execution

**Docker is only required for container-isolated execution/private grading.**
Opening or generating saved reports, preparing/checking a campaign's status and
trusted-local execution do not need it. Start with the
[README first-run walkthrough](../README.md#first-run-one-task-one-deployment)
and choose the boundary before running code. Trusted local has no credential
or arbitrary-process containment; removing isolation is not a Docker fix.

This guide uses the same tiny text task and the implemented `isolation`
configuration. There is **no toolkit-published/reviewed image** supplied.
The image and Docker host must be approved by you/your organization. The
instructions below are actions for your authorized environment, not claims
that live Docker acceptance has already passed.

## 1. Install and select a suitable Linux daemon

Use official installation guidance:
[Windows Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/) |
[macOS Docker Desktop](https://docs.docker.com/desktop/setup/install/mac-install/) |
[Linux Docker Engine](https://docs.docker.com/engine/install/).
Respect platform virtualization requirements and Docker Desktop licensing.
On Windows select **Linux containers** with a supported Linux backend, not
Windows containers. On macOS the daemon also runs inside a Linux VM.

Installing Desktop alone does not prove feasibility. The selected
`DOCKER_HOST`/Docker context must allow Linux containers, named volumes,
read-only volume mounts, nonroot execution, cap-drop/no-new-privileges,
memory/CPU/PID controls and **process freezing via `docker pause`**. Rootless,
remote or restricted corporate daemons may not provide all of these.
Allocate enough VM/daemon memory for the paused candidate plus its exporter,
grading workers and host orchestration. A remote daemon changes the trust
boundary; secure and review that host and connection separately.

```powershell
docker context show
docker version
docker info --format 'OS={{.OSType}} cgroup={{.CgroupVersion}} memory={{.MemTotal}}'
```

Expect a reachable server and `OS=linux`. Inspect warnings about unavailable
resource controls. A version/info check is **not** an isolation test; use the
owned-worker feasibility probe in step 4. The
[Docker pause documentation](https://docs.docker.com/reference/cli/docker/container/pause/)
describes Linux freezer-cgroup suspension of all candidate processes; ordinary
PID enumeration/termination is not a substitute for sealing exports.

## 2. Prepare and review an offline-capable image

For the README text/JSON tasks, only Node standard-library operations are
needed. A compatible Linux image must provide `/usr/local/bin/node`, `node`
on `PATH`, `/bin/sh` and `chmod`. It must work as UID/GID 1000:1000 with a
read-only root and no network. For other tasks, include all task/grader
interpreters, system libraries and dependencies **before** execution.
No runtime package download is possible; input snapshots omit `node_modules`.
Install dependencies in an immutable image location and make them resolvable
from the task's commands (do not assume a workspace dependency directory).

Start from an organization-approved base, such as an approved version of the
[official Node image](https://github.com/nodejs/docker-node), following
[Docker image-building guidance](https://docs.docker.com/build/building/best-practices/).
Review the Dockerfile, base digest, contents, `ENV`, entrypoints, ownership and
dependency provenance. Do not bake in cloud keys, tokens, CLI caches, private
grader assets, customer data or host paths. Limit the build context and use a
`.dockerignore`; never send your home directory or this repo's private run
folders as an image build context. Build-time credentials must not remain in
layers. For the tiny tasks a reviewed existing image can suffice; the toolkit
does not certify any particular public image.

If a custom image is needed, build/review it through your approved image
process, publish it to an authorized registry, and obtain its **repository
manifest digest**. A locally built tag/image ID is not necessarily a usable
`repository@sha256:...` reference. There is no automatic build/push/pull here.

After approval, explicitly pull that exact digest onto the selected daemon:

```powershell
$image = 'YOUR_APPROVED_REPOSITORY@sha256:REPLACE_WITH_64_HEX_MANIFEST_DIGEST'
# Explicit download into your Docker host; do not execute until approved.
docker pull $image
if ($LASTEXITCODE -ne 0) { throw 'Approved image pull failed.' }
docker image inspect $image --format '{{json .RepoDigests}}'
```

Use an actual digest from the image owner/approved registry, not the literal
placeholder or a mutable tag. Confirm architecture compatibility.
[Docker's digest-pull reference](https://docs.docker.com/reference/cli/docker/image/pull/)
explains the distinction from tags. Campaign execution always uses
`--pull never`, so an absent/incompatible image fails, never downloads or
silently switches to host execution.

## 3. Configure isolation before preparing

Follow README steps 1-3 in the same PowerShell 7+ shell, but use a fresh
`$work = '.\.benchmark-runs\first-isolated'` in its copy block. Select key or
[Entra auth](KEYLESS_AUTH.md) on the **host**; Docker does not choose auth.
Stop before README step 4 and add this policy to the copied task:

```powershell
# isolation:configure
$policy = [pscustomobject]@{
    mode = 'container'; image = $image
    memoryMb = 1024; cpus = 1
    maxFiles = 100; maxBytes = 1048576; commandTimeoutMs = 60000
}
$task | Add-Member -NotePropertyName isolation -NotePropertyValue $policy
$task.contract.candidate = $spec.candidates[0].candidate
$task.contract.foundryProvider = $spec.candidates[0].foundryProvider
$spec | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath "$work\campaign.json" -Encoding utf8
$task | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath "$work\text-task.json" -Encoding utf8
$state = "$work\state"
```

An equivalent top-level policy fragment, **not a complete task config**, is:

```json
{
  "isolation": {
    "mode": "container",
    "image": "YOUR_APPROVED_REPOSITORY@sha256:REPLACE_WITH_64_HEX_MANIFEST_DIGEST",
    "memoryMb": 1024,
    "cpus": 1,
    "maxFiles": 100,
    "maxBytes": 1048576,
    "commandTimeoutMs": 60000
  }
}
```

Fill every placeholder before use. A multi-task isolated campaign needs an
`isolation` policy on **every task**; this is not a campaign-level switch.
Do not reuse already prepared local state: mode/image/config changes require
a new immutable campaign. `quickstart` has no Docker/isolation flag; use a
configured campaign or `bench` task instead.

## 4. Check prerequisites, then test the actual boundary without inference

```powershell
npm run doctor -- --config "$work\text-task.json"
```

Expect available daemon and local pinned image. This read-only check starts
no containers and does not prove Linux freezing or security/resource controls.
If keyless credentials also need checking, use `--acquire-auth` separately;
that contacts identity services but still performs no model inference.

The following **optional local Docker acceptance probe** creates named,
UUID-owned resources using the actual toolkit, validates nonroot execution,
imports the example files, freezes the candidate, exports its volume through
the owned read-only helper and cleans only those owned resources. It consumes
no model quota and requires no Azure credentials, but **does change local
Docker resources while it runs**. Execute only with an approved host/image.
Build first (`npm run build`) if `dist` is not current.

```powershell
# isolation:probe
@'
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ControlledWorker, collectSnapshot } from "./dist/index.js";
const configPath = resolve(process.argv[2]), work = resolve(process.argv[3]);
const config = JSON.parse(readFileSync(configPath, "utf8"));
if (config.isolation?.mode !== "container") throw new Error("Isolation policy required.");
const files = collectSnapshot(resolve(dirname(configPath), config.workspacePath),
  config.isolation.maxFiles, config.isolation.maxBytes);
const worker = await ControlledWorker.create(config.isolation, files,
  join(work, "isolation-smoke-worker.json"));
try {
  const check = await worker.validate("node -e 'if(process.getuid()!==1000)process.exit(1)'", 5000);
  if (check.exitCode !== 0 || check.timedOut || check.errorMessage) throw new Error("Nonroot validation failed.");
  const hash = await worker.snapshot(join(work, "isolation-smoke-output"));
  console.log(JSON.stringify({ isolatedExportHash: hash }));
} finally {
  await worker.dispose();
}
'@ | node --input-type=module - "$work\text-task.json" $work
if ($LASTEXITCODE -ne 0) { throw 'Isolation probe failed; do not run inference.' }
```

Expect a snapshot hash and matching `isolation-smoke-output\input.txt`.
A successful smoke is a prerequisite check, **not** proof against kernel
exploits or all task behavior. Review Docker warnings/configuration too.
On failure inspect retained ownership records; do not delete unrelated
resources or disable controls. If cleanup itself fails, retain the exact
record for `ControlledWorker.cleanup(recordPath)` as documented in the
[ownership reference](CAMPAIGNS_AND_PUBLICATION.md#trusted-local-versus-credential-isolated-execution).
Use a new `$work` for another smoke; snapshot destinations are not overwritten.

## 5. Prepare, run and report

Only after the prerequisite checks and image review:

```powershell
# Offline preparation; no model call.
npm run campaign -- prepare --spec "$work\campaign.json" --directory $state
npm run campaign -- status --directory $state
# Cost-bearing model inference; still uses host-side key/Entra transport.
npm run campaign -- run --directory $state --allow-paid
npm run campaign -- status --directory $state
npm run campaign -- report --directory $state --output "$work\isolated-report-v1" --zip
```

Open `isolated-report-v1\index.html` or distribute the reviewed sibling ZIP.
State, retained snapshots/run/grade JSON and worker records remain sensitive
local evidence under `$state`. Resume uses the same implemented command:
`npm run campaign -- resume --directory $state --allow-paid`. It respects
dispatch certainty and never retries until PASS. Report to a fresh `v2`
destination after resume.

During isolated execution the candidate sees only `controlled_workspace`,
no host/MCP tools. The orchestrator keeps real credentials/identity caches and
transport outside the worker. The worker has no injected host binds, socket,
ports or real credential environment; it runs nonroot, network-disabled,
read-only-root, cap-drop ALL/no-new-privileges with bounded resources.
Export uses Linux process freezing and a separate read-only-volume helper;
validation and grading use fresh workers. Private grader files are supplied
separately, not built into the image or copied into candidate input.
See [private grading](CAMPAIGNS_AND_PUBLICATION.md#task-owned-evaluators-and-private-assets).

macOS/Linux users can follow the PowerShell 7 steps with native paths; Docker
CLI arguments are the same. For Bash, translate environment/path syntax and
use a shell heredoc instead of PowerShell's here-string for the Node probe.
**Live Docker enforcement has not been verified by this repository's current
acceptance run**; existing tests cover injected Docker executors. Do not treat
installed Desktop, a successful `doctor`, or those mocked tests as live
container enforcement evidence.
