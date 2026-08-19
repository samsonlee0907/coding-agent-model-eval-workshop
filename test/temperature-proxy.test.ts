import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import test from "node:test";
import { startOpenAiNullRefusalSanitizingProxy, startTemperatureStrippingProxy, stripNullMessageRefusals } from "../src/runner.js";

test("Foundry compatibility proxy removes only temperature and preserves the target path", async () => {
  let receivedPath = "";
  let receivedHeaders: Record<string, string | string[] | undefined> = {};
  let receivedBody: Record<string, unknown> = {};
  const upstream = createServer((incoming, outgoing) => {
    receivedPath = incoming.url ?? "";
    receivedHeaders = incoming.headers;
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      receivedBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ ok: true }));
    });

    test("FW-Kimi-K3 compatibility sanitizer removes only null refusals across continuation message arrays", async () => {
      const requestBody = Buffer.from(JSON.stringify({
        messages: [
          { role: "assistant", content: "first", refusal: null },
          { role: "assistant", content: "keep", refusal: "policy" },
        ],
        continuation: { messages: [{ role: "assistant", refusal: null, tool_calls: [] }] },
      }));
      const sanitized = JSON.parse(stripNullMessageRefusals(requestBody, "application/json").toString("utf8")) as {
        messages: Array<Record<string, unknown>>;
        continuation: { messages: Array<Record<string, unknown>> };
      };
      assert.equal("refusal" in sanitized.messages[0]!, false);
      assert.equal(sanitized.messages[1]?.refusal, "policy");
      assert.equal("refusal" in sanitized.continuation.messages[0]!, false);

      let receivedBody: Record<string, unknown> = {};
      const upstream = createServer((incoming, outgoing) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("end", () => {
          receivedBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
          outgoing.writeHead(400, { "content-type": "application/json" });
          outgoing.end(JSON.stringify({ error: "upstream diagnostic" }));
        });
      });
      await listen(upstream);
      const address = upstream.address();
      assert.ok(address && typeof address !== "string");
      const proxy = await startOpenAiNullRefusalSanitizingProxy(`http://127.0.0.1:${address.port}/openai/v1`);
      try {
        const response = await postJson(`${proxy.baseUrl}/chat/completions`, JSON.parse(requestBody.toString("utf8")) as Record<string, unknown>);
        assert.equal(response.statusCode, 400);
        assert.equal((receivedBody.messages as Array<Record<string, unknown>>)[0]?.refusal, undefined);
      } finally {
        await proxy.stop();
        await close(upstream);
      }
    });
  });
  await listen(upstream);
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  const proxy = await startTemperatureStrippingProxy(`http://127.0.0.1:${address.port}/anthropic`);

  try {
    const response = await postJson(`${proxy.baseUrl}/v1/messages`, {
      model: "claude-sonnet-5",
      max_tokens: 128,
      temperature: 0.2,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(receivedPath, "/anthropic/v1/messages");
    assert.equal(receivedHeaders["x-api-key"], "test-key");
    assert.deepEqual(receivedBody, { model: "claude-sonnet-5", max_tokens: 128 });
  } finally {
    await proxy.stop();
    await close(upstream);
  }
});

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function postJson(url: string, body: Record<string, unknown>): Promise<{ statusCode: number | undefined }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const requestToProxy = request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
        "x-api-key": "test-key",
      },
    }, (response) => {
      response.resume();
      response.once("end", () => resolve({ statusCode: response.statusCode }));
    });
    requestToProxy.once("error", reject);
    requestToProxy.end(payload);
  });
}
