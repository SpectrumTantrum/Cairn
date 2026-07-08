// CloudProvider adapter gate (ADR-0002 BYOK). No network: every request is served
// by an injected fake fetch that captures request shaping and replays canned SSE /
// JSON bodies. Covers per-kind request shaping, streaming parse, usage/cost
// surfacing, error mapping, and the load-bearing embed() refusal.

import assert from "node:assert/strict";
import { before, test } from "node:test";

let CloudProvider;
let PROVIDER_PRESETS;

before(async () => {
  const engine = await import("../dist/index.js");
  CloudProvider = engine.CloudProvider;
  PROVIDER_PRESETS = engine.PROVIDER_PRESETS;
});

const enc = new TextEncoder();

/** A Response-shaped object whose body streams `text` in two byte chunks (exercises buffering). */
function streamResponse(text) {
  const mid = Math.floor(text.length / 2);
  return {
    ok: true,
    status: 200,
    body: (async function* () {
      yield enc.encode(text.slice(0, mid));
      yield enc.encode(text.slice(mid));
    })(),
    async text() {
      return text;
    },
    async json() {
      return JSON.parse(text);
    },
  };
}

function jsonResponse(obj) {
  return {
    ok: true,
    status: 200,
    body: null,
    async json() {
      return obj;
    },
    async text() {
      return JSON.stringify(obj);
    },
  };
}

function errorResponse(status, body) {
  return { ok: false, status, async text() { return body; } };
}

/** Capture the (url, init) of the single request and reply with `response`. */
function captureFetch(response) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return response;
  };
  return { impl, calls };
}

const MESSAGES = [
  { role: "system", content: "SYS" },
  { role: "user", content: "hi" },
];

test("openai-compat: request shaping + SSE stream + usage/cost", async () => {
  const sse =
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n' +
    'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12,"cost":0.0003}}\n\n' +
    "data: [DONE]\n\n";
  const { impl, calls } = captureFetch(streamResponse(sse));
  const p = new CloudProvider({
    kind: "openai-compat",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    credentials: { apiKey: "sk-test" },
    extraBody: { usage: { include: true } }, // OpenRouter-style cost opt-in
    fetchImpl: impl,
  });

  const tokens = [];
  let usage;
  const full = await p.chatStream("gpt-4o-mini", MESSAGES, {
    onToken: (t) => tokens.push(t),
    onUsage: (u) => (usage = u),
  });

  assert.equal(full, "Hello");
  assert.deepEqual(tokens, ["Hel", "lo"]);
  assert.equal(usage.totalTokens, 12);
  assert.equal(usage.costUsd, 0.0003);

  const { url, init } = calls[0];
  assert.equal(url, "https://api.openai.com/v1/chat/completions");
  assert.equal(init.headers["Authorization"], "Bearer sk-test");
  const body = JSON.parse(init.body);
  assert.equal(body.model, "gpt-4o-mini");
  assert.equal(body.stream, true);
  assert.equal(body.stream_options.include_usage, true);
  assert.deepEqual(body.usage, { include: true });
  assert.equal(body.messages.length, 2); // system stays inline for openai-compat
});

test("anthropic: system split out, native headers, SSE parse + combined usage", async () => {
  const sse =
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":20}}}\n\n' +
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n' +
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":" there"}}\n\n' +
    'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":4}}\n\n';
  const { impl, calls } = captureFetch(streamResponse(sse));
  const p = new CloudProvider({
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-3-5-sonnet",
    apiVersion: "2023-06-01",
    credentials: { apiKey: "sk-ant" },
    fetchImpl: impl,
  });

  let usage;
  const full = await p.chatStream("claude-3-5-sonnet", MESSAGES, { onUsage: (u) => (usage = u) });

  assert.equal(full, "Hi there");
  assert.equal(usage.promptTokens, 20);
  assert.equal(usage.completionTokens, 4);
  assert.equal(usage.totalTokens, 24); // finalized from prompt + completion

  const { url, init } = calls[0];
  assert.equal(url, "https://api.anthropic.com/v1/messages");
  assert.equal(init.headers["x-api-key"], "sk-ant");
  assert.equal(init.headers["anthropic-version"], "2023-06-01");
  const body = JSON.parse(init.body);
  assert.equal(body.system, "SYS"); // system extracted to top-level param
  assert.equal(body.messages.length, 1); // only the user turn remains
  assert.equal(body.messages[0].role, "user");
  assert.equal(typeof body.max_tokens, "number");
});

test("azure-openai: deployment URL + api-version + api-key header, no stream_options", async () => {
  const sse = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n';
  const { impl, calls } = captureFetch(streamResponse(sse));
  const p = new CloudProvider({
    kind: "azure-openai",
    baseUrl: "https://res.openai.azure.com",
    model: "gpt-4o",
    deployment: "gpt4o-deploy",
    apiVersion: "2024-10-21",
    credentials: { apiKey: "az-key" },
    fetchImpl: impl,
  });

  const full = await p.chatStream("gpt-4o", MESSAGES);
  assert.equal(full, "ok");

  const { url, init } = calls[0];
  assert.equal(
    url,
    "https://res.openai.azure.com/openai/deployments/gpt4o-deploy/chat/completions?api-version=2024-10-21",
  );
  assert.equal(init.headers["api-key"], "az-key");
  assert.equal(init.headers["Authorization"], undefined);
  const body = JSON.parse(init.body);
  assert.equal(body.stream_options, undefined); // Azure: omitted (older api-versions reject it)
});

test("bedrock: SigV4-signed Converse request + non-stream text/usage", async () => {
  const { impl, calls } = captureFetch(
    jsonResponse({
      output: { message: { content: [{ text: "grounded answer" }] } },
      usage: { inputTokens: 30, outputTokens: 8, totalTokens: 38 },
    }),
  );
  const p = new CloudProvider({
    kind: "bedrock",
    baseUrl: "",
    model: "anthropic.claude-3-sonnet-20240229-v1:0",
    region: "us-east-1",
    credentials: { accessKeyId: "AKIA_TEST", secretAccessKey: "secret_test" },
    fetchImpl: impl,
  });

  const tokens = [];
  let usage;
  const full = await p.chatStream("anthropic.claude-3-sonnet-20240229-v1:0", MESSAGES, {
    onToken: (t) => tokens.push(t),
    onUsage: (u) => (usage = u),
  });

  assert.equal(full, "grounded answer");
  assert.deepEqual(tokens, ["grounded answer"]); // non-stream: whole answer as one token
  assert.equal(usage.totalTokens, 38);

  const signed = calls[0].url; // aws.sign returns a Request; fetchImpl gets it as the first arg
  const signedUrl = typeof signed === "string" ? signed : signed.url;
  assert.match(
    signedUrl,
    /^https:\/\/bedrock-runtime\.us-east-1\.amazonaws\.com\/model\/anthropic\.claude-3-sonnet-20240229-v1%3A0\/converse$/,
  );
  const authHeader = typeof signed === "object" ? signed.headers.get("authorization") : null;
  assert.match(authHeader ?? "", /AWS4-HMAC-SHA256/); // proof SigV4 actually signed the request
});

test("embed() is refused — retrieval never routes to the cloud", async () => {
  const p = new CloudProvider({ kind: "openai-compat", baseUrl: "https://x/v1", model: "m" });
  await assert.rejects(() => p.embed("m", ["x"]), /not used for embeddings/);
});

test("HTTP error maps to a Cloud-prefixed message (not mistaken for local Ollama)", async () => {
  const { impl } = captureFetch(errorResponse(401, "invalid key"));
  const p = new CloudProvider({
    kind: "openai-compat",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o",
    credentials: { apiKey: "bad" },
    fetchImpl: impl,
  });
  await assert.rejects(
    () => p.chatStream("gpt-4o", MESSAGES),
    /^Error: Cloud chat\/completions request failed \(HTTP 401\)/,
  );
});

test("preset registry ships every provider with a verified/editable base URL", () => {
  const ids = PROVIDER_PRESETS.map((p) => p.id);
  for (const required of [
    "openai", "openrouter", "gemini", "mistral", "xai", "deepseek", "cohere",
    "groq", "together", "fireworks", "deepinfra", "cerebras", "huggingface",
    "anthropic", "azure-openai", "bedrock", "custom",
  ]) {
    assert.ok(ids.includes(required), `missing preset: ${required}`);
  }
  // No secret material may live in a shipped preset.
  for (const p of PROVIDER_PRESETS) {
    assert.equal("credentials" in p, false);
    assert.equal("apiKey" in p, false);
  }
});
