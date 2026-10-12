import { StringDecoder } from "node:string_decoder";
import { DispatchError } from "./request-policy.js";

/** SSE data fields form one UTF-8 event; transport chunks are not lines/events. */
export class ProviderStream {
  private readonly decoder = new StringDecoder("utf8");
  private line = "";
  private data: string[] = [];
  private skipLf = false;
  private eventBytes = 0;
  private terminal = false;
  private first = true;
  constructor(private readonly route: string) {}
  push(chunk: Buffer): void { this.read(this.decoder.write(chunk)); }
  finish(): void {
    this.read(this.decoder.end());
    if (this.line || this.data.length) throw new DispatchError("Provider stream ended inside an SSE event.", "possibly-processed");
    if (!this.terminal) throw new DispatchError("Provider stream ended without valid completion evidence.", "possibly-processed");
  }
  private read(text: string): void {
    for (const char of text) {
      if (this.first) { this.first = false; if (char === "\uFEFF") continue; }
      if (this.skipLf && char === "\n") { this.skipLf = false; continue; }
      this.skipLf = false;
      this.eventBytes += Buffer.byteLength(char);
      if (this.eventBytes > 16 * 1024 * 1024) throw new DispatchError("Provider SSE event exceeds the 16 MiB byte bound.", "possibly-processed");
      if (char === "\r" || char === "\n") {
        this.acceptLine(); this.skipLf = char === "\r";
      } else this.line += char;
    }
  }
  private acceptLine(): void {
    const line = this.line; this.line = "";
    if (line === "") {
      if (this.data.length) this.acceptEvent(this.data.join("\n"));
      this.data = []; this.eventBytes = 0; return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.data.push(value);
  }
  private acceptEvent(data: string): void {
    const responses = this.route.split("?")[0].endsWith("/responses");
    const messages = this.route.split("?")[0].endsWith("/messages");
    if (data === "[DONE]") {
      if (!responses && !messages) this.terminal = true;
      return;
    }
    let event: unknown;
    try { event = JSON.parse(data); }
    catch { throw new DispatchError("Malformed provider SSE event JSON.", "possibly-processed"); }
    if (!event || typeof event !== "object") throw new DispatchError("Invalid provider SSE event.", "possibly-processed");
    const record = event as Record<string, unknown>;
    if (record.error || ["error", "response.failed", "response.incomplete"].includes(String(record.type))) {
      throw new DispatchError("Provider SSE signaled an error or incomplete response.", "possibly-processed");
    }
    if (responses && record.type === "response.completed") {
      const response = record.response;
      if (!response || typeof response !== "object" || !("status" in response) || response.status !== "completed"
          || !("output" in response) || !Array.isArray(response.output)) {
        throw new DispatchError("Provider completion event lacks a completed response.", "possibly-processed");
      }
      this.terminal = true;
    }
    if (messages && record.type === "message_stop") this.terminal = true;
  }
}
