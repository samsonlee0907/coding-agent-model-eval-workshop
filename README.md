# Coding Agent Model Eval Workshop

The workshop guide is the primary documentation:
[Microsoft Foundry ModelOps routing workshop](./docs/FOUNDRY_MODELOPS_WORKSHOP.md).

It explains candidate discovery, provider protocol selection, local quickstart,
fair multi-model comparisons, deterministic evaluators, tool-profile isolation,
and how to turn results into a versioned coding-task routing policy.

## Workshop flow

1. Discover only models and deployments currently available in the selected
   Foundry project and region; record version, context, quota, endpoint
   protocol, tool support, and price source.
2. Run the same coding task family from equivalent local baselines with a fixed
   prompt, tools, timeout, validation command, and environment fingerprint.
3. Gate candidates on deterministic build/test results before comparing cost or
   latency. Include failures, rate limits, timeouts, and tool failures.
4. Build routing rules per task family using resolved rate, cost per resolved
   task, p95 latency, availability, safety/compliance needs, and fallbacks.
5. Shadow-route first, canary second, then continuously re-evaluate after a
   model, deployment, prompt, tool, or task-suite change.

## Prerequisites

- Node.js, npm, Git, and an isolated local workspace. No GitHub repository is
  needed for quickstart.
- A model endpoint plus credential available through shell environment
  variables; never write secrets to configuration or artifacts.
- A Foundry project/region and catalog/deployment/quota access when evaluating
  Foundry models.
- Deterministic test/build validation for each coding task and restricted
  storage for raw agent traces.

## Quick links

- [Start a local benchmark](./docs/FOUNDRY_MODELOPS_WORKSHOP.md#start-a-local-benchmark)
- [Candidate connection profiles](./docs/FOUNDRY_MODELOPS_WORKSHOP.md#candidate-connection-profiles)
- [ModelOps workshop flow](./docs/FOUNDRY_MODELOPS_WORKSHOP.md#recommended-workshop-flow)
- [Included A* coding scenario](./scenarios/interactive-pathfinding-visualizer/task.md)
- [GitHub Copilot SDK BYOK reference](https://github.com/github/copilot-sdk/blob/main/docs/auth/byok.md)
