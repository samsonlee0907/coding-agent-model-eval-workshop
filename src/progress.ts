import type { NormalizedEvent } from "./types.js";

export type ProgressWriter = (line: string) => void;

/**
 * Emits a compact, content-free view of the streaming agent lifecycle. Full
 * event envelopes and deltas remain in the NDJSON artifacts.
 */
export function createTerminalProgressReporter(
  write: ProgressWriter = (line) => process.stdout.write(`${line}\n`),
): (event: NormalizedEvent) => void {
  let toolStarts = 0;
  const progress = {
    activeTurn: null as string | null,
    streamedTurns: new Set<string>(),
  };
  return (event) => {
    const line = progressLine(event, progress, () => ++toolStarts);
    if (line) {
      write(`[benchmark] ${line}`);
    }
  };
}

function progressLine(
  event: NormalizedEvent,
  progress: { activeTurn: string | null; streamedTurns: Set<string> },
  nextToolStart: () => number,
): string | null {
  switch (event.eventType) {
    case "runner.run_started":
      return "Starting run; waiting for the agent session.";
    case "session.start":
      return `Session ready${typeof event.data.selectedModel === "string" ? ` for ${event.data.selectedModel}` : ""}.`;
    case "runner.round_started":
      return `Round ${typeof event.data.round === "number" ? event.data.round : "?"} sent; awaiting agent activity.`;
    case "assistant.turn_start": {
      progress.activeTurn = typeof event.data.turnId === "string"
        ? event.data.turnId
        : event.eventId ?? `event-${event.sequence}`;
      return `Agent turn ${typeof event.data.turnId === "string" ? event.data.turnId : "?"} started.`;
    }
    case "assistant.streaming_delta":
    case "assistant.message_delta": {
      const turn = progress.activeTurn
        ?? (typeof event.data.messageId === "string" ? `message:${event.data.messageId}` : null);
      if (!turn || progress.streamedTurns.has(turn)) {
        return null;
      }
      progress.streamedTurns.add(turn);
      return "Model response is streaming.";
    }
    case "tool.execution_start": {
      const count = nextToolStart();
      if (count > 5 && count % 5 !== 0) {
        return null;
      }
      const toolName = typeof event.data.toolName === "string" ? event.data.toolName : "unknown";
      return `Tool activity #${count}: ${toolName}.`;
    }
    case "tool.execution_complete":
      return event.data.success === false ? "A tool reported failure; the agent may repair it." : null;
    case "runner.round_finished":
      return `Round ${typeof event.data.round === "number" ? event.data.round : "?"} finished.`;
    case "runner.validation_finished":
      return `Validation ${event.data.exitCode === 0 ? "passed" : "finished with a non-zero exit code"}.`;
    case "runner.error":
      return "The agent runtime reported an error; continuing to deterministic validation.";
    case "runner.run_finished":
      return "Run complete; writing benchmark artifacts and report.";
    default:
      return null;
  }
}
