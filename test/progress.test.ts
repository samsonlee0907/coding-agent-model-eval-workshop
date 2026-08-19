import assert from "node:assert/strict";
import test from "node:test";
import { createTerminalProgressReporter } from "../src/progress.js";
import { event } from "./fixtures/events.js";

test("terminal progress reports lifecycle and samples tool activity without response content", () => {
  const lines: string[] = [];
  const report = createTerminalProgressReporter((line) => lines.push(line));
  report(event(1, "runner.run_started", "2026-08-18T00:00:00.000Z"));
  report(event(2, "assistant.turn_start", "2026-08-18T00:00:01.000Z", { turnId: "turn-1" }));
  report(event(3, "assistant.message_delta", "2026-08-18T00:00:01.100Z", { messageId: "message-1", deltaContent: "secret response text" }));
  report(event(4, "assistant.message_delta", "2026-08-18T00:00:01.200Z", { messageId: "message-1", deltaContent: "more secret response text" }));
  report(event(5, "tool.execution_start", "2026-08-18T00:00:02.000Z", { toolName: "powershell" }));
  report(event(6, "runner.validation_finished", "2026-08-18T00:00:03.000Z", { exitCode: 0 }));

  assert.deepEqual(lines, [
    "[benchmark] Starting run; waiting for the agent session.",
    "[benchmark] Agent turn turn-1 started.",
    "[benchmark] Model response is streaming.",
    "[benchmark] Tool activity #1: powershell.",
    "[benchmark] Validation passed.",
  ]);
  assert.doesNotMatch(lines.join("\n"), /secret response text/);
});
