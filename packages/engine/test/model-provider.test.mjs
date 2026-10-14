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

test("OllamaClient.chatWithTools streams answer tokens on the same /v1 body as tool turns", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  let streams = 0;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body });
    if (body.stream === true && streams === 0) {
      streams += 1;
      const sse = [
        'data: {"choices":[{"delta":{"content":"Hel"}}]}',
        'data: {"choices":[{"delta":{"content":"lo"}}]}',
        "data: [DONE]",
      ].join("\n");
      return new Response(sse, { status: 200 });
    }
    if (body.stream === true) {
      streams += 1;
      return new Response("", { status: 200 });
    }
    return new Response(
      JSON.stringify({ choices: [{ message: { role: "assistant", content: "retried", tool_calls: [] } }] }),
      { status: 200 },
    );
  };
  try {
    const engine = await import("../dist/index.js");
    engine.resetOllamaHttpClient();
    const client = new engine.OllamaClient("http://ollama.test");
    const tokens = [];
    const tools = [{ name: "find", description: "search", parameters: { type: "object", properties: {} } }];
    const history = [
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_abc", name: "find", arguments: { query: "notes" } }],
      },
      { role: "tool", toolName: "find", toolCallId: "call_abc", content: "ok" },
    ];
    const streamed = await client.chatWithTools("qwen3:8b", history, tools, {
      onToken: (token) => tokens.push(token),
    });
    assert.deepEqual(tokens, ["Hel", "lo"]);
    assert.equal(streamed.content, "Hello");
    assert.equal(streamed.toolCalls.length, 0);
    assert.equal(calls[0].url, "http://ollama.test/v1/chat/completions");
    assert.equal(calls[0].body.stream, true);
    assert.equal(calls[0].body.temperature, 0);
    assert.equal(calls[0].body.reasoning_effort, "none");
    assert.equal(calls[0].body.think, false);
    assert.equal(calls[0].body.options, undefined);
    assert.equal(calls[0].body.messages[2].tool_call_id, "call_abc");
    assert.equal(calls[0].body.messages[2].tool_name, undefined);

    tokens.length = 0;
    const retried = await client.chatWithTools("qwen3:8b", [{ role: "user", content: "q" }], tools, {
      onToken: (token) => tokens.push(token),
    });
    assert.deepEqual(tokens, []);
    assert.equal(retried.content, "retried");
    assert.equal(calls.at(-1).url, "http://ollama.test/v1/chat/completions");
    assert.equal(calls.at(-1).body.stream, false);
    assert.equal(calls.at(-1).body.reasoning_effort, "none");
  } finally {
    globalThis.fetch = originalFetch;
    const engine = await import("../dist/index.js");
    engine.resetModelProvider();
    engine.resetOllamaHttpClient();
  }
});

test("a streamed tool turn maps a body timeout to OllamaTimeoutError and a user abort to AbortError", async () => {
  const originalFetch = globalThis.fetch;
  const hangUntilAbort = (init) => {
    const stream = new ReadableStream({
      start(controller) {
        const signal = init?.signal;
        const fail = () => {
          controller.error(signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"));
        };
        if (signal?.aborted) fail();
        else signal?.addEventListener("abort", fail, { once: true });
      },
    });
    return new Response(stream, { status: 200 });
  };
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    const engine = await import("../dist/index.js");
    engine.resetOllamaHttpClient();
    const client = new engine.OllamaClient("http://ollama.test");
    const tools = [{ name: "find", description: "search", parameters: { type: "object", properties: {} } }];
    globalThis.fetch = async (_url, init) => hangUntilAbort(init);
    await assert.rejects(
      () => client.chatWithTools("qwen3:8b", [{ role: "user", content: "q" }], tools, { onToken() {}, timeoutMs: 40 }),
      (err) => err instanceof engine.OllamaTimeoutError,
    );

    const ac = new AbortController();
    const pending = client.chatWithTools("qwen3:8b", [{ role: "user", content: "q" }], tools, {
      onToken() {},
      signal: ac.signal,
      timeoutMs: 5_000,
    });
    setTimeout(() => ac.abort(), 10);
    await assert.rejects(
      pending,
      (err) => err instanceof DOMException && err.name === "AbortError" && !(err instanceof engine.OllamaTimeoutError),
    );
  } finally {
    clearInterval(keepAlive);
    globalThis.fetch = originalFetch;
    const engine = await import("../dist/index.js");
    engine.resetModelProvider();
    engine.resetOllamaHttpClient();
  }
});

test("streamed tool calls from separate chunks are all kept", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const line = (obj) => `data: ${JSON.stringify(obj)}`;
    const sse = [
      line({ choices: [{ delta: { content: "Looking. " } }] }),
      line({
        choices: [{ delta: { tool_calls: [{ index: 0, id: "call_grep", function: { name: "grep", arguments: '{"pat' } }] } }],
      }),
      line({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: 'tern":"finch"}' } },
                { index: 1, id: "call_read", function: { name: "read", arguments: '{"path":"notes/a.md"}' } },
              ],
            },
          },
        ],
      }),
      "data: [DONE]",
    ].join("\n");
    return new Response(sse, { status: 200 });
  };
  try {
    const engine = await import("../dist/index.js");
    engine.resetOllamaHttpClient();
    const client = new engine.OllamaClient("http://ollama.test");
    const tokens = [];
    const tools = [{ name: "find", description: "search", parameters: { type: "object", properties: {} } }];
    const turn = await client.chatWithTools("qwen3:8b", [{ role: "user", content: "q" }], tools, {
      onToken: (token) => tokens.push(token),
    });
    assert.deepEqual(tokens, ["Looking. "]);
    assert.deepEqual(
      turn.toolCalls.map((call) => ({ name: call.name, arguments: call.arguments })),
      [
        { name: "grep", arguments: { pattern: "finch" } },
        { name: "read", arguments: { path: "notes/a.md" } },
      ],
    );
  } finally {
    globalThis.fetch = originalFetch;
    const engine = await import("../dist/index.js");
    engine.resetModelProvider();
    engine.resetOllamaHttpClient();
  }
});

test("malformed streamed tool JSON retries the non-streaming /v1 call", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.stream);
    if (body.stream === true) {
      const sse = `data: ${JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "grep", arguments: "{bad" } }] } }],
      })}\n`;
      return new Response(sse, { status: 200 });
    }
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{ id: "call_ok", type: "function", function: { name: "grep", arguments: '{"pattern":"finch"}' } }],
            },
          },
        ],
      }),
      { status: 200 },
    );
  };
  try {
    const engine = await import("../dist/index.js");
    engine.resetOllamaHttpClient();
    const client = new engine.OllamaClient("http://ollama.test");
    const tools = [{ name: "grep", description: "search", parameters: { type: "object", properties: {} } }];
    const turn = await client.chatWithTools("qwen3:8b", [{ role: "user", content: "q" }], tools, { onToken() {} });
    assert.deepEqual(calls, [true, false]);
    assert.equal(turn.toolCalls.length, 1);
    assert.equal(turn.toolCalls[0].id, "call_ok");
    assert.equal(turn.toolCalls[0].arguments.pattern, "finch");
  } finally {
    globalThis.fetch = originalFetch;
    const engine = await import("../dist/index.js");
    engine.resetModelProvider();
    engine.resetOllamaHttpClient();
  }
});

test("an empty tool stream retries with the time left on the turn deadline", async () => {
  const originalFetch = globalThis.fetch;
  const originalTimeout = AbortSignal.timeout;
  const budgets = [];
  AbortSignal.timeout = (ms) => {
    budgets.push(ms);
    return originalTimeout.call(AbortSignal, ms);
  };
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).endsWith("/v1/chat/completions") && body.stream === true) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return new Response("", { status: 200 });
    }
    return new Response(
      JSON.stringify({ choices: [{ message: { role: "assistant", content: "retried", tool_calls: [] } }] }),
      { status: 200 },
    );
  };
  try {
    const engine = await import("../dist/index.js");
    engine.resetOllamaHttpClient();
    const client = new engine.OllamaClient("http://ollama.test");
    const tools = [{ name: "find", description: "search", parameters: { type: "object", properties: {} } }];
    const turn = await client.chatWithTools("qwen3:8b", [{ role: "user", content: "q" }], tools, {
      onToken() {},
      timeoutMs: 500,
    });
    assert.equal(turn.content, "retried");
    assert.equal(budgets[0], 500);
    assert.ok(budgets[1] < 500);
    assert.ok(budgets[1] <= 470);
  } finally {
    AbortSignal.timeout = originalTimeout;
    globalThis.fetch = originalFetch;
    const engine = await import("../dist/index.js");
    engine.resetModelProvider();
    engine.resetOllamaHttpClient();
  }
});

test("classic chatStream forwards a user abort as AbortError", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const stream = new ReadableStream({
      start(controller) {
        const signal = init?.signal;
        const fail = () => {
          controller.error(signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"));
        };
        if (signal?.aborted) fail();
        else signal?.addEventListener("abort", fail, { once: true });
      },
    });
    return new Response(stream, { status: 200 });
  };
  try {
    const engine = await import("../dist/index.js");
    engine.resetOllamaHttpClient();
    const client = new engine.OllamaClient("http://ollama.test");
    const ac = new AbortController();
    const pending = client.chatStream("qwen3:4b", [{ role: "user", content: "q" }], { signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    await assert.rejects(
      pending,
      (err) => err instanceof DOMException && err.name === "AbortError" && !(err instanceof engine.OllamaTimeoutError),
    );
  } finally {
    globalThis.fetch = originalFetch;
    const engine = await import("../dist/index.js");
    engine.resetModelProvider();
    engine.resetOllamaHttpClient();
  }
});

function showResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("OllamaClient.modelInfo reads tools from POST /api/show and never throws", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, body: JSON.parse(init.body) });
    const model = JSON.parse(init.body).model;
    if (model === "qwen3:8b") return showResponse({ capabilities: ["completion", "tools", "thinking"] });
    if (model === "llama3.2") return showResponse({ capabilities: ["completion"] });
    if (model === "missing-field") return showResponse({ details: {} });
    if (model === "http-error") return new Response("nope", { status: 500 });
    if (model === "refused") throw new TypeError("fetch failed");
    if (model === "timed-out") {
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      throw err;
    }
    return showResponse({});
  };
  try {
    const engine = await import("../dist/index.js");
    engine.resetOllamaHttpClient();
    const client = new engine.OllamaClient("http://ollama.test");
    assert.equal(await client.modelInfo("qwen3:8b"), "capable");
    assert.equal(calls[0].url, "http://ollama.test/api/show");
    assert.equal(calls[0].method, "POST");
    assert.deepEqual(calls[0].body, { model: "qwen3:8b" });
    assert.equal(await client.modelInfo("llama3.2"), "incapable");
    assert.equal(await client.modelInfo("missing-field"), "unknown");
    assert.equal(await client.modelInfo("http-error"), "unknown");
    assert.equal(await client.modelInfo("refused"), "unknown");
    assert.equal(await client.modelInfo("timed-out"), "unknown");
    assert.equal(await client.modelInfo(""), "unknown");
    assert.equal(await client.modelInfo("qwen3-embedding:0.6b"), "unknown");
    assert.equal(calls.some((call) => call.body.model === "qwen3-embedding:0.6b"), false);
    assert.equal(calls.some((call) => call.body.model === ""), false);
  } finally {
    globalThis.fetch = originalFetch;
    const engine = await import("../dist/index.js");
    engine.resetModelProvider();
    engine.resetOllamaHttpClient();
  }
});

test("OllamaClient.modelInfo caches per exact model name and clears on up-after-down", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const model = JSON.parse(init.body).model;
    calls.push(model);
    if (model === "qwen3:8b") return showResponse({ capabilities: ["tools"] });
    if (model === "qwen3:4b") return showResponse({ capabilities: ["completion", "tools"] });
    throw new TypeError("fetch failed");
  };
  try {
    const engine = await import("../dist/index.js");
    engine.resetOllamaHttpClient();
    const client = new engine.OllamaClient("http://ollama.test");
    client.noteOllamaReachability(true);
    assert.equal(await client.modelInfo("qwen3:8b"), "capable");
    assert.equal(await client.modelInfo("qwen3:8b"), "capable");
    assert.equal(await client.modelInfo("qwen3:4b"), "capable");
    assert.deepEqual(calls, ["qwen3:8b", "qwen3:4b"]);
    client.noteOllamaReachability(true);
    assert.equal(await client.modelInfo("qwen3:8b"), "capable");
    assert.deepEqual(calls, ["qwen3:8b", "qwen3:4b"]);
    assert.equal(await client.modelInfo("gone"), "unknown");
    assert.equal(await client.modelInfo("gone"), "unknown");
    assert.deepEqual(calls, ["qwen3:8b", "qwen3:4b", "gone"]);
    client.noteOllamaReachability(false);
    client.noteOllamaReachability(false);
    assert.equal(await client.modelInfo("qwen3:8b"), "capable");
    assert.deepEqual(calls, ["qwen3:8b", "qwen3:4b", "gone"]);
    client.noteOllamaReachability(true);
    assert.equal(await client.modelInfo("qwen3:8b"), "capable");
    assert.equal(await client.modelInfo("gone"), "unknown");
    assert.deepEqual(calls, ["qwen3:8b", "qwen3:4b", "gone", "qwen3:8b", "gone"]);
  } finally {
    globalThis.fetch = originalFetch;
    const engine = await import("../dist/index.js");
    engine.resetModelProvider();
    engine.resetOllamaHttpClient();
  }
});

test("an in-flight /api/show does not refill the cache cleared by up-after-down", async () => {
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  let started = () => {};
  const startedGate = new Promise((resolve) => {
    started = resolve;
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      started();
      await gate;
    }
    return showResponse({ capabilities: ["tools"] });
  };
  try {
    const engine = await import("../dist/index.js");
    engine.resetOllamaHttpClient();
    const client = new engine.OllamaClient("http://ollama.test");
    client.noteOllamaReachability(true);
    const pending = client.modelInfo("qwen3:8b");
    await startedGate;
    client.noteOllamaReachability(false);
    client.noteOllamaReachability(true);
    release();
    assert.equal(await pending, "capable");
    assert.equal(await client.modelInfo("qwen3:8b"), "capable");
    assert.equal(calls, 2);
  } finally {
    release();
    globalThis.fetch = originalFetch;
    const engine = await import("../dist/index.js");
    engine.resetModelProvider();
    engine.resetOllamaHttpClient();
  }
});

test("probeForWarm clears modelInfo when the instance changes without going down", async () => {
  const calls = [];
  let startedAt = "10";
  let fail = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const path = String(url);
    calls.push(path);
    if (fail) throw new Error("connect ECONNREFUSED");
    if (path.endsWith("/api/version")) {
      return showResponse({ version: "0.6.0", started_at: startedAt });
    }
    if (path.endsWith("/api/tags")) return showResponse({ models: [{ name: "qwen3:8b" }] });
    if (path.endsWith("/api/ps")) return showResponse({ models: [{ name: "qwen3:8b" }] });
    if (path.endsWith("/api/show")) return showResponse({ capabilities: ["tools"] });
    return new Response("nope", { status: 500 });
  };
  const shows = () => calls.filter((path) => path.endsWith("/api/show")).length;
  try {
    const engine = await import("../dist/index.js");
    engine.resetOllamaHttpClient();
    const client = new engine.OllamaClient("http://ollama.test");
    const boot = await client.probeForWarm();
    assert.equal(boot.up, true);
    assert.equal(boot.recovered, true);
    assert.equal(await client.modelInfo("qwen3:8b"), "capable");
    assert.equal(shows(), 1);
    const steady = await client.probeForWarm();
    assert.equal(steady.up, true);
    assert.equal(steady.recovered, false);
    assert.equal(await client.modelInfo("qwen3:8b"), "capable");
    assert.equal(shows(), 1);
    startedAt = "11";
    const bounced = await client.probeForWarm();
    assert.equal(bounced.up, true);
    assert.equal(bounced.recovered, true);
    assert.equal(await client.modelInfo("qwen3:8b"), "capable");
    assert.equal(shows(), 2);
    fail = true;
    assert.deepEqual(await client.probeForWarm(), { up: false, models: [], recovered: false });
    fail = false;
    assert.equal(await client.modelInfo("qwen3:8b"), "capable");
    assert.equal(shows(), 2);
    const back = await client.probeForWarm();
    assert.equal(back.up, true);
    assert.equal(back.recovered, true);
    assert.equal(await client.modelInfo("qwen3:8b"), "capable");
    assert.equal(shows(), 3);
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

function installOllama(state) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const path = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    state.calls.push({ path, body });
    if (state.fail) throw new Error("connect ECONNREFUSED");
    if (path.endsWith("/api/version")) {
      if (state.versionStatus && state.versionStatus !== 200) {
        return new Response("nope", { status: state.versionStatus });
      }
      return new Response(JSON.stringify(state.version ?? {}), { status: 200 });
    }
    if (path.endsWith("/api/tags")) {
      const tags = state.tags ?? ["qwen3:4b", "qwen3:8b"];
      return new Response(JSON.stringify({ models: tags.map((name) => ({ name })) }), { status: 200 });
    }
    if (path.endsWith("/api/ps")) {
      return new Response(JSON.stringify({ models: state.ps ?? [] }), { status: 200 });
    }
    if (path.endsWith("/api/embed")) {
      return new Response(JSON.stringify({ embeddings: [[0.01]] }), { status: 200 });
    }
    if (body && body.keep_alive === 0 && state.releaseStatus) {
      return new Response("busy", { status: state.releaseStatus });
    }
    if (path.endsWith("/v1/chat/completions") && state.completionsStatus) {
      return new Response("missing", { status: state.completionsStatus });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), { status: 200 });
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function installHangingOllama(state) {
  const originalFetch = globalThis.fetch;
  state.calls = [];
  state.hangs = [];
  state.maxLiveWarms = 0;
  globalThis.fetch = async (url, init) => {
    const path = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    state.calls.push({ path, body });
    if (path.endsWith("/api/tags")) {
      const tags = state.tags ?? ["qwen3:4b", "qwen3:8b", "nomic-embed-text"];
      return new Response(JSON.stringify({ models: tags.map((name) => ({ name })) }), { status: 200 });
    }
    if (path.endsWith("/api/ps")) {
      return new Response(JSON.stringify({ models: state.ps ?? [] }), { status: 200 });
    }
    if (path.endsWith("/api/version")) {
      return new Response(JSON.stringify({ version: "0.6.0" }), { status: 200 });
    }
    if (path.endsWith("/api/embed")) {
      return new Response(JSON.stringify({ embeddings: [[0.01]] }), { status: 200 });
    }
    if (body?.keep_alive === 0 && !state.hangRelease) {
      return new Response("{}", { status: 200 });
    }
    const signal = init?.signal;
    let resume = () => {};
    const hang = { path, body, signal, done: false, resume: () => {} };
    const gate = new Promise((resolve, reject) => {
      const abort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
      resume = () => {
        hang.done = true;
        resolve();
      };
    });
    hang.resume = resume;
    state.hangs.push(hang);
    if (body?.keep_alive !== 0) {
      const live = state.hangs.filter(
        (entry) => !entry.done && !entry.signal?.aborted && entry.body?.keep_alive !== 0,
      ).length;
      state.maxLiveWarms = Math.max(state.maxLiveWarms, live);
    }
    await gate;
    if (body?.keep_alive === 0) return new Response("{}", { status: 200 });
    if (body?.stream) {
      return new Response(`${JSON.stringify({ message: { content: "x" }, done: true })}\n`, { status: 200 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "x" } }] }), { status: 200 });
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

async function waitFor(predicate) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 2000) {
      throw new Error("timed out waiting for warm-up");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("warm prompts are the real Ask prefixes", async () => {
  const engine = await import("../dist/index.js");
  const agentic = engine.chatWarmRequest("agentic");
  assert.equal(agentic.kind, "agentic");
  assert.equal(agentic.messages[0].content, engine.ASK_AGENT_SYSTEM);
  assert.equal(agentic.messages[1].content, engine.AGENTIC_WARM_USER_PREFIX);
  assert.equal(engine.AGENTIC_WARM_USER_PREFIX, "QUESTION: ");
  const user = engine.agenticAskUserContent("tide pools", null);
  assert.equal(user.startsWith(engine.AGENTIC_WARM_USER_PREFIX), true);
  assert.match(user, /No retrieval seed was injected/);
  assert.deepEqual(
    agentic.tools.map((tool) => tool.name),
    ["list", "find", "grep", "read", "open"],
  );
  assert.equal(agentic.tools[0].description, engine.ASK_SEARCH_TOOLS[0].description);
  assert.deepEqual(agentic.tools[0].parameters, engine.ASK_SEARCH_TOOLS[0].parameters);

  const classic = engine.chatWarmRequest("classic");
  assert.equal(classic.kind, "classic");
  assert.equal(classic.messages[0].content, engine.GROUNDING_SYSTEM);
  assert.equal(classic.messages[1].content, "SOURCES:\n");
  assert.equal(classic.tools, undefined);
  assert.equal(engine.classicAskUserContent("notes", "q"), "SOURCES:\nnotes\n\nQUESTION: q");
  assert.equal(engine.classicAskUserContent("notes", "q").startsWith(engine.CLASSIC_USER_PREFIX), true);
});

test("agentic warm posts the tool prompt and classic warm posts the grounding prefix", async () => {
  const state = { calls: [], ps: [] };
  const restore = installOllama(state);
  try {
    const engine = await import("../dist/index.js");
    engine.resetOllamaHttpClient();
    const client = new engine.OllamaClient("http://ollama.test");
    assert.equal(await client.warmChatModel("nomic-embed-text", engine.chatWarmRequest("agentic")), "skipped");
    assert.equal(state.calls.length, 0);
    assert.equal(await client.warmChatModel("qwen3:8b", engine.chatWarmRequest("agentic")), "warmed");
    const agentic = state.calls.filter((call) => call.path.endsWith("/v1/chat/completions"));
    assert.equal(agentic.length, 1);
    assert.equal(state.calls.some((call) => call.path.endsWith("/api/chat")), false);
    assert.equal(state.calls.some((call) => call.path.includes("/api/embed")), false);
    const request = engine.chatWarmRequest("agentic");
    assert.equal(agentic[0].body.model, "qwen3:8b");
    assert.equal(agentic[0].body.stream, false);
    assert.equal(agentic[0].body.temperature, 0);
    assert.equal(agentic[0].body.reasoning_effort, "none");
    assert.equal(agentic[0].body.think, false);
    assert.equal(agentic[0].body.tool_choice, "required");
    assert.equal(agentic[0].body.max_tokens, 1);
    assert.equal(agentic[0].body.keep_alive, undefined);
    assert.equal(agentic[0].body.options, undefined);
    assert.equal(agentic[0].body.num_ctx, undefined);
    assert.deepEqual(agentic[0].body.messages, request.messages);
    assert.deepEqual(
      agentic[0].body.tools.map((tool) => tool.function.name),
      ["list", "find", "grep", "read", "open"],
    );
    assert.equal(agentic[0].body.tools[0].function.description, engine.ASK_SEARCH_TOOLS[0].description);
    assert.deepEqual(agentic[0].body.tools[0].function.parameters, engine.ASK_SEARCH_TOOLS[0].parameters);

    state.ps = [{ name: "qwen3:8b:latest", model: "qwen3:8b:latest" }];
    assert.equal(await client.warmChatModel("qwen3:8b:latest", engine.chatWarmRequest("agentic")), "skipped");
    assert.equal(state.calls.filter((call) => call.path.endsWith("/v1/chat/completions")).length, 1);

    assert.equal(await client.warmChatModel("qwen3:4b", engine.chatWarmRequest("classic")), "warmed");
    const release = state.calls.filter((call) => call.body?.keep_alive === 0);
    assert.equal(release.length, 1);
    assert.equal(release[0].path.endsWith("/api/chat"), true);
    assert.equal(release[0].body.model, "qwen3:8b");
    assert.deepEqual(release[0].body.messages, []);
    assert.equal(release[0].body.stream, false);
    const classic = state.calls.filter(
      (call) => call.path.endsWith("/api/chat") && call.body?.model === "qwen3:4b",
    );
    assert.equal(classic.length, 1);
    assert.ok(state.calls.indexOf(release[0]) < state.calls.indexOf(classic[0]));
    assert.deepEqual(classic[0].body, {
      model: "qwen3:4b",
      messages: engine.chatWarmRequest("classic").messages,
      stream: true,
      think: false,
      options: { num_predict: 1 },
    });
  } finally {
    restore();
    const engine = await import("../dist/index.js");
    engine.resetModelProvider();
    engine.resetOllamaHttpClient();
  }
});

test("a resident model is still primed until this process has cached that prompt", async () => {
  const state = { calls: [], ps: [{ name: "qwen3:8b", model: "qwen3:8b" }] };
  const restore = installOllama(state);
  try {
    const engine = await import("../dist/index.js");
    engine.resetOllamaHttpClient();
    const client = new engine.OllamaClient("http://ollama.test");
    const agentic = engine.chatWarmRequest("agentic");
    assert.equal(await client.warmChatModel("qwen3:8b", agentic), "warmed");
    assert.equal(state.calls.filter((call) => call.path.endsWith("/v1/chat/completions")).length, 1);
    assert.equal(await client.warmChatModel("qwen3:8b", agentic), "skipped");
    assert.equal(state.calls.filter((call) => call.path.endsWith("/v1/chat/completions")).length, 1);
    assert.equal(await client.warmChatModel("qwen3:8b", engine.chatWarmRequest("classic")), "warmed");
    assert.equal(state.calls.filter((call) => call.body?.keep_alive === 0).length, 0);
    const classic = state.calls.filter(
      (call) => call.path.endsWith("/api/chat") && call.body?.model === "qwen3:8b" && call.body?.think === false,
    );
    assert.equal(classic.length, 1);
    assert.equal(classic[0].body.messages[1].content, "SOURCES:\n");
  } finally {
    restore();
    const engine = await import("../dist/index.js");
    engine.resetModelProvider();
    engine.resetOllamaHttpClient();
  }
});

test("warmChatModel failure stays silent and can be retried", async () => {
  const state = { calls: [], fail: true, ps: [] };
  const restore = installOllama(state);
  try {
    const engine = await import("../dist/index.js");
    engine.resetOllamaHttpClient();
    const client = new engine.OllamaClient("http://ollama.test");
    const classic = engine.chatWarmRequest("classic");
    assert.equal(await client.warmChatModel("qwen3:4b", classic), "failed");
    state.fail = false;
    assert.equal(await client.warmChatModel("qwen3:4b", classic), "warmed");
    state.releaseStatus = 500;
    state.ps = [{ name: "qwen3:4b" }];
    assert.equal(await client.warmChatModel("qwen3:8b", engine.chatWarmRequest("agentic")), "warmed");
    assert.equal(state.calls.some((call) => call.body?.keep_alive === 0), true);
    assert.equal(state.calls.some((call) => call.path.endsWith("/v1/chat/completions")), true);
  } finally {
    restore();
    const engine = await import("../dist/index.js");
    engine.resetModelProvider();
    engine.resetOllamaHttpClient();
  }
});

test("an older Ollama without /v1 still primes the agentic prompt natively", async () => {
  const state = { calls: [], ps: [], completionsStatus: 404 };
  const restore = installOllama(state);
  try {
    const engine = await import("../dist/index.js");
    engine.resetOllamaHttpClient();
    const client = new engine.OllamaClient("http://ollama.test");
    assert.equal(await client.warmChatModel("qwen3:8b", engine.chatWarmRequest("agentic")), "warmed");
    const native = state.calls.filter((call) => call.path.endsWith("/api/chat"));
    assert.equal(native.length, 1);
    assert.equal(native[0].body.think, false);
    assert.equal(native[0].body.stream, false);
    assert.equal(native[0].body.keep_alive, undefined);
    assert.deepEqual(native[0].body.options, { num_predict: 1 });
    assert.equal(native[0].body.num_ctx, undefined);
    assert.deepEqual(
      native[0].body.tools.map((tool) => tool.function.name),
      ["list", "find", "grep", "read", "open"],
    );
    assert.equal(native[0].body.messages[0].content, engine.ASK_AGENT_SYSTEM);
  } finally {
    restore();
    const engine = await import("../dist/index.js");
    engine.resetModelProvider();
    engine.resetOllamaHttpClient();
  }
});

test("the newest chat-model pick aborts the in-flight warm and unloads only that model", async () => {
  const state = { hangRelease: false };
  const restore = installHangingOllama(state);
  try {
    const engine = await import("../dist/index.js");
    engine.resetOllamaHttpClient();
    const client = new engine.OllamaClient("http://ollama.test");
    const agentic = engine.chatWarmRequest("agentic");
    const first = client.warmChatModel("qwen3:4b", agentic);
    const joined = client.warmChatModel("qwen3:4b", agentic);
    await waitFor(() => state.hangs.length === 1);
    assert.equal(state.calls.filter((call) => call.path.endsWith("/v1/chat/completions")).length, 1);
    assert.equal(state.hangs[0].body.model, "qwen3:4b");
    assert.equal(state.hangs[0].body.max_tokens, 1);
    assert.equal(state.hangs[0].body.keep_alive, undefined);
    assert.equal(state.hangs[0].body.options, undefined);
    assert.equal(state.hangs[0].body.num_ctx, undefined);

    const second = client.warmChatModel("qwen3:8b", agentic);
    await waitFor(() => state.hangs.filter((entry) => !entry.signal?.aborted && !entry.done).length === 1);
    assert.equal(state.hangs.length, 2);
    assert.equal(state.hangs[0].signal.aborted, true);
    assert.equal(state.maxLiveWarms, 1);
    const release = state.calls.filter((call) => call.body?.keep_alive === 0);
    assert.equal(release.length, 1);
    assert.equal(release[0].body.model, "qwen3:4b");
    assert.equal(release.some((call) => /embed/i.test(String(call.body?.model ?? ""))), false);
    const next = state.calls.find(
      (call) => call.path.endsWith("/v1/chat/completions") && call.body?.model === "qwen3:8b",
    );
    assert.ok(next);
    assert.equal(next.body.max_tokens, 1);
    assert.ok(state.calls.indexOf(release[0]) < state.calls.indexOf(next));
    assert.equal(
      state.calls.filter((call) => call.path.endsWith("/v1/chat/completions") && call.body?.model === "qwen3:4b")
        .length,
      1,
    );

    state.hangs.find((entry) => !entry.signal?.aborted && !entry.done).resume();
    assert.equal(await first, "failed");
    assert.equal(await joined, "failed");
    assert.equal(await second, "warmed");
    const embed = state.calls.filter((call) => call.path.endsWith("/api/embed"));
    assert.equal(embed.length, 1);
    assert.equal(embed[0].body.keep_alive, undefined);
    assert.equal(state.calls.filter((call) => call.body?.keep_alive === 0).length, 1);
  } finally {
    restore();
    const engine = await import("../dist/index.js");
    engine.resetModelProvider();
    engine.resetOllamaHttpClient();
  }
});

test("a newer Ask mode aborts the warm and does not unload the same model", async () => {
  const state = { hangRelease: false };
  const restore = installHangingOllama(state);
  try {
    const engine = await import("../dist/index.js");
    engine.resetOllamaHttpClient();
    const client = new engine.OllamaClient("http://ollama.test");
    const first = client.warmChatModel("qwen3:8b", engine.chatWarmRequest("agentic"));
    await waitFor(() => state.hangs.length === 1);
    const second = client.warmChatModel("qwen3:8b", engine.chatWarmRequest("classic"));
    await waitFor(() => state.hangs.some((entry) => entry.body?.stream === true && !entry.signal?.aborted));
    assert.equal(state.hangs[0].signal.aborted, true);
    assert.equal(state.maxLiveWarms, 1);
    assert.equal(state.calls.filter((call) => call.body?.keep_alive === 0).length, 0);
    const classic = state.hangs.find((entry) => entry.body?.stream === true);
    assert.deepEqual(classic.body.options, { num_predict: 1 });
    assert.equal(classic.body.keep_alive, undefined);
    assert.equal(classic.body.num_ctx, undefined);
    assert.equal(classic.body.messages[1].content, "SOURCES:\n");
    classic.resume();
    assert.equal(await first, "failed");
    assert.equal(await second, "warmed");
  } finally {
    restore();
    const engine = await import("../dist/index.js");
    engine.resetModelProvider();
    engine.resetOllamaHttpClient();
  }
});

test("switching back aborts the unload of the model just picked", async () => {
  const state = { hangRelease: true };
  const restore = installHangingOllama(state);
  try {
    const engine = await import("../dist/index.js");
    engine.resetOllamaHttpClient();
    const client = new engine.OllamaClient("http://ollama.test");
    const agentic = engine.chatWarmRequest("agentic");
    const first = client.warmChatModel("qwen3:4b", agentic);
    await waitFor(() => state.hangs.some((entry) => entry.body?.model === "qwen3:4b" && entry.body?.max_tokens === 1));
    const second = client.warmChatModel("qwen3:8b", agentic);
    await waitFor(() =>
      state.hangs.some((entry) => entry.body?.keep_alive === 0 && entry.body?.model === "qwen3:4b" && !entry.done),
    );
    const third = client.warmChatModel("qwen3:4b", agentic);
    await waitFor(() => {
      const release4 = state.hangs.find((entry) => entry.body?.keep_alive === 0 && entry.body?.model === "qwen3:4b");
      const release8 = state.hangs.find((entry) => entry.body?.keep_alive === 0 && entry.body?.model === "qwen3:8b");
      return release4?.signal.aborted === true && release8 && !release8.signal.aborted && !release8.done;
    });
    assert.equal(state.maxLiveWarms, 1);
    assert.equal(
      state.calls.filter((call) => call.body?.keep_alive === 0 && /embed/i.test(String(call.body?.model ?? ""))).length,
      0,
    );
    state.hangs.find((entry) => entry.body?.keep_alive === 0 && entry.body?.model === "qwen3:8b").resume();
    await waitFor(() =>
      state.hangs.some((entry) => entry.body?.max_tokens === 1 && entry.body?.model === "qwen3:4b" && !entry.signal?.aborted && !entry.done),
    );
    const live = state.hangs.filter(
      (entry) => entry.body?.max_tokens === 1 && !entry.signal?.aborted && !entry.done,
    );
    assert.equal(live.length, 1);
    assert.equal(live[0].body.model, "qwen3:4b");
    live[0].resume();
    assert.equal(await first, "failed");
    assert.equal(await second, "failed");
    assert.equal(await third, "warmed");
  } finally {
    restore();
    const engine = await import("../dist/index.js");
    engine.resetModelProvider();
    engine.resetOllamaHttpClient();
  }
});

test("prime options match the real Ask, and a steady poll does not unload or re-embed", async () => {
  const state = {
    calls: [],
    ps: [],
    tags: ["qwen3-embedding:latest", "nomic-embed-text", "qwen3:4b", "qwen3:8b"],
  };
  const restore = installOllama(state);
  try {
    const engine = await import("../dist/index.js");
    const { DEFAULT_EMBED } = await import("../dist/embed.js");
    engine.resetOllamaHttpClient();
    const client = new engine.OllamaClient("http://ollama.test");
    const agenticWarm = engine.chatWarmRequest("agentic");
    assert.equal(await client.warmChatModel("qwen3:8b", agenticWarm), "warmed");
    const agenticPrime = state.calls.find((call) => call.path.endsWith("/v1/chat/completions"));
    await client.chatWithTools("qwen3:8b", agenticWarm.messages, agenticWarm.tools, {
      requireToolCall: true,
    });
    const agenticAsk = state.calls.filter((call) => call.path.endsWith("/v1/chat/completions")).at(-1);
    assert.equal(agenticPrime.body.max_tokens, 1);
    assert.equal(agenticAsk.body.max_tokens, undefined);
    assert.equal(agenticPrime.body.keep_alive, undefined);
    assert.equal(agenticAsk.body.keep_alive, undefined);
    assert.equal(agenticPrime.body.num_ctx, undefined);
    assert.equal(agenticAsk.body.num_ctx, undefined);
    const { max_tokens: _primeCap, ...agenticPrimeRest } = agenticPrime.body;
    assert.deepEqual(agenticPrimeRest, agenticAsk.body);

    const embeds = state.calls.filter((call) => call.path.endsWith("/api/embed"));
    assert.equal(embeds.length, 1);
    assert.equal(embeds[0].body.model, DEFAULT_EMBED);
    assert.deepEqual(embeds[0].body.input, ["."]);
    assert.equal(embeds[0].body.keep_alive, undefined);
    assert.equal(Object.keys(embeds[0].body).sort().join(), "input,model");

    state.ps = [
      { name: "qwen3:8b" },
      { name: "qwen3-embedding:0.6b" },
    ];
    const before = state.calls.length;
    assert.equal(await client.warmChatModel("qwen3:8b", engine.chatWarmRequest("agentic")), "skipped");
    const added = state.calls.slice(before);
    assert.equal(added.some((call) => call.path.endsWith("/v1/chat/completions")), false);
    assert.equal(added.some((call) => call.path.endsWith("/api/embed")), false);
    assert.equal(added.some((call) => call.body?.keep_alive === 0), false);

    state.ps = [{ name: "qwen3:8b" }];
    assert.equal(await client.warmChatModel("qwen3:8b", engine.chatWarmRequest("agentic")), "skipped");
    const reembed = state.calls.filter((call) => call.path.endsWith("/api/embed"));
    assert.equal(reembed.length, 2);
    assert.deepEqual(reembed[1].body, embeds[0].body);

    state.ps = [{ name: "qwen3:8b" }, { name: DEFAULT_EMBED }];
    const classicWarm = engine.chatWarmRequest("classic");
    assert.equal(await client.warmChatModel("qwen3:4b", classicWarm), "warmed");
    const classicPrime = state.calls.filter(
      (call) => call.path.endsWith("/api/chat") && call.body?.model === "qwen3:4b" && call.body?.think === false,
    ).at(-1);
    engine.setModelProvider(client);
    await engine.chatStream("qwen3:4b", classicWarm.messages, {
      onToken() {},
    });
    const classicAsk = state.calls.filter((call) => call.path.endsWith("/api/chat") && call.body?.stream === true).at(-1);
    assert.equal(classicPrime.body.stream, true);
    assert.equal(classicPrime.body.think, false);
    assert.equal(classicAsk.body.think, false);
    assert.equal(classicPrime.body.keep_alive, undefined);
    assert.deepEqual(classicPrime.body.options, { num_predict: 1 });
    assert.equal(classicAsk.body.options, undefined);
    assert.equal(classicPrime.body.num_ctx, undefined);
    assert.equal(classicAsk.body.num_ctx, undefined);
    const { options: _classicCap, ...classicPrimeRest } = classicPrime.body;
    assert.deepEqual(classicPrimeRest, classicAsk.body);
    const releases = state.calls.filter((call) => call.body?.keep_alive === 0);
    assert.equal(releases.length, 1);
    assert.equal(releases[0].body.model, "qwen3:8b");
    assert.equal(releases.some((call) => /embed/i.test(String(call.body?.model ?? ""))), false);

    const embedsBeforeRestart = state.calls.filter((call) => call.path.endsWith("/api/embed")).length;
    state.ps = [];
    assert.equal((await client.probeForWarm()).recovered, true);
    state.ps = [{ name: "qwen3:4b" }];
    assert.equal(await client.warmChatModel("qwen3:4b", engine.chatWarmRequest("classic")), "warmed");
    assert.ok(state.calls.filter((call) => call.path.endsWith("/api/embed")).length > embedsBeforeRestart);
  } finally {
    restore();
    const engine = await import("../dist/index.js");
    engine.resetModelProvider();
    engine.resetOllamaHttpClient();
  }
});

test("classic streaming keeps think:false and never emits reasoning", async () => {
  const calls = [];
  let attempt = 0;
  const originalFetch = globalThis.fetch;
  const hello = [
    JSON.stringify({ message: { content: "<thi", thinking: "hidden reasoning" }, done: false }),
    JSON.stringify({ message: { content: "nk>plan the answer</think>Hel" }, done: false }),
    JSON.stringify({ message: { thinking: "still hidden", content: "" }, done: false }),
    JSON.stringify({ message: { content: "lo" }, done: true }),
  ].join("\n");
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init.body));
    calls.push(body);
    attempt += 1;
    if (attempt === 1) return new Response("overloaded", { status: 500 });
    if (attempt === 3) {
      return new Response(JSON.stringify({ message: { content: "<think>secret" }, done: true }), { status: 200 });
    }
    return new Response(hello, { status: 200 });
  };
  try {
    const engine = await import("../dist/index.js");
    engine.resetOllamaHttpClient();
    const client = new engine.OllamaClient("http://ollama.test");
    await assert.rejects(client.chatStream("qwen3:4b", [{ role: "user", content: "q" }]), /HTTP 500/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].think, false);
    assert.equal(calls[0].stream, true);
    assert.equal(calls[0].keep_alive, undefined);
    assert.equal(calls[0].options, undefined);

    engine.setModelProvider(client);
    const tokens = [];
    const answer = await engine.chatStream("qwen3:4b", [{ role: "user", content: "q" }], {
      onToken: (token) => tokens.push(token),
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].think, false);
    assert.equal(tokens.join(""), "Hello");
    assert.equal(answer, "Hello");
    assert.equal(tokens.some((token) => /plan the answer|hidden|think/i.test(token)), false);

    const hidden = [];
    const unclosed = await engine.chatStream("qwen3:4b", [{ role: "user", content: "q" }], {
      onToken: (token) => hidden.push(token),
    });
    assert.deepEqual(hidden, []);
    assert.equal(unclosed, "");
  } finally {
    globalThis.fetch = originalFetch;
    const engine = await import("../dist/index.js");
    engine.resetModelProvider();
    engine.resetOllamaHttpClient();
  }
});

test("an old server that rejects think is retried once, and the answer stays visible text", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init.body));
    calls.push(body);
    if (body.think !== undefined) {
      return new Response('{"error":"unknown field \\"think\\""}', { status: 400 });
    }
    const lines = [
      JSON.stringify({ message: { content: "<think>secret</think>Noted" }, done: true }),
    ].join("\n");
    return new Response(lines, { status: 200 });
  };
  try {
    const engine = await import("../dist/index.js");
    engine.resetOllamaHttpClient();
    engine.setModelProvider(new engine.OllamaClient("http://ollama.test"));
    const tokens = [];
    const answer = await engine.chatStream("qwen3:4b", [{ role: "user", content: "q" }], {
      onToken: (token) => tokens.push(token),
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].think, false);
    assert.equal(calls[1].think, undefined);
    assert.equal(tokens.join(""), "Noted");
    assert.equal(answer, "Noted");
  } finally {
    globalThis.fetch = originalFetch;
    const engine = await import("../dist/index.js");
    engine.resetModelProvider();
    engine.resetOllamaHttpClient();
  }
});

test("a fresh profile defaults to qwen3:8b in both modes, not the first tag", async () => {
  const engine = await import("../dist/index.js");
  const tags = ["gemma4:e4b", "nomic-embed-text", "llama3.2:3b", "qwen3:4b", "qwen3:8b"];
  const classic = { agentic: false, envModel: undefined };
  const agentic = { agentic: true, envModel: undefined };
  assert.equal(engine.pickChatModel(tags, undefined, classic), "qwen3:8b");
  assert.equal(engine.pickChatModel(tags, undefined, agentic), "qwen3:8b");
  assert.equal(engine.pickChatModel(tags, undefined, agentic), engine.pickChatModel(tags, undefined, classic));
  assert.equal(engine.pickChatModel(tags, "llama3.2:3b", agentic), "llama3.2:3b");
  assert.equal(engine.pickChatModel(tags, "qwen3:4b", classic), "qwen3:4b");
  assert.equal(engine.pickChatModel(["nomic-embed-text"], undefined, agentic), null);

  const without8b = ["gemma4:e4b", "qwen3:4b", "llama3.2:3b"];
  assert.equal(engine.pickChatModel(without8b, undefined, classic), "qwen3:4b");
  assert.equal(engine.pickChatModel(without8b, undefined, agentic), "qwen3:4b");
  const legacyOnly = ["gemma4:e4b", "llama3.2:3b"];
  assert.equal(engine.pickChatModel(legacyOnly, undefined, classic), "llama3.2:3b");
  assert.equal(engine.pickChatModel(legacyOnly, undefined, agentic), "llama3.2:3b");

  const previous = process.env.CHAT_MODEL;
  delete process.env.CHAT_MODEL;
  setModelProvider(new FakeModelProvider({ models: tags }));
  try {
    assert.equal(await engine.resolveChatModel(undefined, { agentic: true }), "qwen3:8b");
    assert.equal(await engine.resolveChatModel(), "qwen3:8b");
    assert.equal(await engine.resolveChatModel("gemma4:e4b"), "gemma4:e4b");
  } finally {
    if (previous === undefined) delete process.env.CHAT_MODEL;
    else process.env.CHAT_MODEL = previous;
    resetModelProvider();
  }
});

test("nextOllamaWarmGate is only the down-to-up edge", async () => {
  const engine = await import("../dist/index.js");
  assert.deepEqual(engine.nextOllamaWarmGate(false, false), { wasUp: false, recovered: false });
  assert.deepEqual(engine.nextOllamaWarmGate(false, true), { wasUp: true, recovered: true });
  assert.deepEqual(engine.nextOllamaWarmGate(true, true), { wasUp: true, recovered: false });
  assert.deepEqual(engine.nextOllamaWarmGate(true, false), { wasUp: false, recovered: false });
});

test("ollama instance identity changes when the process start changes", async () => {
  const engine = await import("../dist/index.js");
  assert.equal(engine.ollamaInstanceToken({}), "");
  assert.equal(engine.ollamaInstanceToken({ version: "0.6.0" }), "version:0.6.0");
  assert.equal(
    engine.ollamaInstanceToken({ version: "0.6.0", startedAt: "100" }),
    "start:100",
  );
  const held = { token: "", held: "qwen3:8b", sawHeld: false };
  assert.equal(engine.ollamaWarmInvalidated(held, { token: "start:1", running: [] }), false);
  assert.equal(
    engine.ollamaWarmInvalidated(
      { token: "start:1", held: "qwen3:8b", sawHeld: true },
      { token: "start:1", running: ["qwen3:8b:latest"] },
    ),
    false,
  );
  assert.equal(
    engine.ollamaWarmInvalidated(
      { token: "start:1", held: "qwen3:8b", sawHeld: true },
      { token: "start:2", running: ["qwen3:8b"] },
    ),
    true,
  );
  assert.equal(
    engine.ollamaWarmInvalidated(
      { token: "version:0.6.0", held: "qwen3:8b", sawHeld: true },
      { token: "version:0.6.0", running: [] },
    ),
    true,
  );
  assert.equal(
    engine.ollamaWarmInvalidated(
      { token: "version:0.6.0", held: "qwen3:8b", sawHeld: false },
      { token: "version:0.6.0", running: [] },
    ),
    false,
  );
  assert.equal(
    engine.ollamaWarmInvalidated(
      { token: "version:0.6.0", held: "qwen3:8b", sawHeld: true },
      { token: "", running: [] },
    ),
    true,
  );
  assert.equal(
    engine.ollamaWarmInvalidated(
      { token: "version:0.6.0", held: "qwen3:8b", sawHeld: true },
      { token: "version:0.6.0", running: null },
    ),
    false,
  );
});

test("a restart rewarms when /api/ps loses the model or the process start changes", async () => {
  const state = {
    calls: [],
    ps: [],
    tags: ["nomic-embed-text", "qwen3:4b", "qwen3:8b"],
    version: { version: "0.6.0", started_at: "10" },
  };
  const restore = installOllama(state);
  try {
    const engine = await import("../dist/index.js");
    engine.resetOllamaHttpClient();
    const client = new engine.OllamaClient("http://ollama.test");
    const agentic = engine.chatWarmRequest("agentic");
    const boot = await client.probeForWarm();
    assert.equal(boot.up, true);
    assert.equal(boot.recovered, true);
    assert.deepEqual(boot.models, state.tags);
    assert.equal(await client.warmChatModel("qwen3:8b", agentic), "warmed");

    state.ps = [{ name: "qwen3:8b:latest", model: "qwen3:8b:latest" }];
    const steady = await client.probeForWarm();
    assert.equal(steady.recovered, false);
    assert.equal(steady.up, true);
    const primed = state.calls.filter((call) => call.path.endsWith("/v1/chat/completions")).length;
    assert.equal(await client.warmChatModel("qwen3:8b", agentic), "skipped");
    assert.equal(state.calls.filter((call) => call.path.endsWith("/v1/chat/completions")).length, primed);

    state.versionStatus = 500;
    assert.equal((await client.probeForWarm()).recovered, false);
    state.versionStatus = undefined;
    assert.equal((await client.probeForWarm()).recovered, false);

    state.ps = [];
    const lost = await client.probeForWarm();
    assert.equal(lost.up, true);
    assert.equal(lost.recovered, true);
    assert.equal(await client.warmChatModel("qwen3:8b", agentic), "warmed");
    assert.equal(state.calls.filter((call) => call.path.endsWith("/v1/chat/completions")).length, primed + 1);

    state.ps = [{ name: "qwen3:8b" }];
    const relatched = await client.probeForWarm();
    assert.equal(relatched.recovered, false);
    state.version = { version: "0.6.0", started_at: "11" };
    const bounced = await client.probeForWarm();
    assert.equal(bounced.recovered, true);
    assert.equal(bounced.up, true);
    assert.equal(await client.warmChatModel("qwen3:8b", agentic), "warmed");
    assert.equal(state.calls.filter((call) => call.path.endsWith("/v1/chat/completions")).length, primed + 2);

    state.version = { version: "0.6.0", uptime: 4 };
    state.ps = [{ name: "qwen3:8b" }];
    const uptimeBoot = await client.probeForWarm();
    assert.equal(uptimeBoot.recovered, true);
    assert.equal(await client.warmChatModel("qwen3:4b", engine.chatWarmRequest("classic")), "warmed");
    state.ps = [{ name: "qwen3:4b" }];
    assert.equal((await client.probeForWarm()).recovered, false);
    state.version = { version: "0.6.0", uptime: 9 };
    assert.equal((await client.probeForWarm()).recovered, true);

    state.fail = true;
    const down = await client.probeForWarm();
    assert.deepEqual(down, { up: false, models: [], recovered: false });
    state.fail = false;
    state.version = { version: "0.6.0", uptime: 9 };
    const back = await client.probeForWarm();
    assert.equal(back.up, true);
    assert.equal(back.recovered, true);
  } finally {
    restore();
    const engine = await import("../dist/index.js");
    engine.resetModelProvider();
    engine.resetOllamaHttpClient();
  }
});
