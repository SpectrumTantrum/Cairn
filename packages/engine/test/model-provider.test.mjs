import assert from "node:assert/strict";
import { after, before, test } from "node:test";

let setModelProvider;
let resetModelProvider;
let resetOllamaHttpClient;
let FakeModelProvider;
let getModelProvider;

before(async () => {
  const engine = await import("../dist/index.js");
  const testing = await import("../dist/testing.js");
  setModelProvider = engine.setModelProvider;
  resetModelProvider = engine.resetModelProvider;
  resetOllamaHttpClient = engine.resetOllamaHttpClient;
  getModelProvider = engine.getModelProvider;
  FakeModelProvider = testing.FakeModelProvider;
});

after(() => {
  resetModelProvider();
  resetOllamaHttpClient();
});

test("FakeModelProvider reports reachability from opts", async () => {
  setModelProvider(new FakeModelProvider({ reachable: false, models: [] }));
  assert.equal(await getModelProvider().isReachable(), false);

  setModelProvider(new FakeModelProvider({ models: ["qwen3:4b"] }));
  assert.equal(await getModelProvider().isReachable(), true);
  assert.deepEqual(await getModelProvider().listModels(), ["qwen3:4b"]);
});

test("agentMessagesToOpenAI replays assistant tool_calls with stringified arguments", async () => {
  const { agentMessagesToOpenAI } = await import("../dist/index.js");
  const mapped = agentMessagesToOpenAI([
    { role: "user", content: "q" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_abc", name: "find", arguments: { query: "notes" } }],
    },
    { role: "tool", toolName: "find", toolCallId: "call_abc", content: "ok" },
  ]);
  assert.equal(mapped.length, 3);
  const assistant = mapped[1];
  assert.equal(assistant.role, "assistant");
  assert.equal(assistant.tool_calls[0].type, "function");
  assert.equal(assistant.tool_calls[0].function.arguments, '{"query":"notes"}');
  assert.deepEqual(mapped[2], { role: "tool", tool_call_id: "call_abc", content: "ok" });
});

test("OllamaClient.chatWithTools prefers OpenAI-compat /v1/chat/completions", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "find", arguments: '{"query":"spaced"}' },
                },
              ],
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  try {
    const engine = await import("../dist/index.js");
    engine.resetOllamaHttpClient();
    engine.setModelProvider(new engine.OllamaClient("http://ollama.test"));
    const turn = await engine.getModelProvider().chatWithTools(
      "qwen3:4b",
      [{ role: "user", content: "q" }],
      [
        {
          name: "find",
          description: "search",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      ],
      { timeoutMs: 12_000 },
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://ollama.test/v1/chat/completions");
    assert.equal(calls[0].body.temperature, 0);
    assert.equal(calls[0].body.reasoning_effort, "none");
    assert.equal(calls[0].body.think, false);
    assert.equal(turn.toolCalls.length, 1);
    assert.equal(turn.toolCalls[0].name, "find");
    assert.equal(turn.toolCalls[0].arguments.query, "spaced");
    assert.equal(turn.toolCalls[0].id, "call_1");
  } finally {
    globalThis.fetch = originalFetch;
    const engine = await import("../dist/index.js");
    engine.resetModelProvider();
    engine.resetOllamaHttpClient();
  }
});

test("OllamaClient.chatWithTools can require a tool call on the first turn", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "", tool_calls: [] } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  try {
    const engine = await import("../dist/index.js");
    engine.resetOllamaHttpClient();
    engine.setModelProvider(new engine.OllamaClient("http://ollama.test"));
    await engine.getModelProvider().chatWithTools(
      "qwen3:8b",
      [{ role: "user", content: "q" }],
      [{ name: "find", description: "search", parameters: { type: "object", properties: {} } }],
      { requireToolCall: true },
    );
    assert.equal(calls[0].body.tool_choice, "required");
  } finally {
    globalThis.fetch = originalFetch;
    const engine = await import("../dist/index.js");
    engine.resetModelProvider();
    engine.resetOllamaHttpClient();
  }
});

test("OllamaClient and embed delegate through the same provider seam", async () => {
  setModelProvider(
    new FakeModelProvider({
      models: ["test-embedder"],
      embed: (_model, input) => Promise.resolve(input.map(() => [0.5, 0.5])),
    }),
  );
  const { embed, ollamaUp } = await import("../dist/embed.js");
  assert.equal(await ollamaUp(), true);
  const vectors = await embed("test-embedder", ["probe"]);
  assert.deepEqual(vectors, [[0.5, 0.5]]);
});
