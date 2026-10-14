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

test("warmChatModel loads a chat model once and never the embedder", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const path = String(url);
    calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (path.endsWith("/api/ps")) {
      return new Response(JSON.stringify({ models: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({ done: true, done_reason: "load" }), { status: 200 });
  };
  try {
    const engine = await import("../dist/index.js");
    engine.resetOllamaHttpClient();
    const client = new engine.OllamaClient("http://ollama.test");
    assert.equal(await client.warmChatModel("qwen3-embedding:0.6b"), "skipped");
    assert.equal(calls.length, 0);
    assert.equal(await client.warmChatModel("qwen3:8b"), "warmed");
    assert.equal(await client.warmChatModel("qwen3:8b:latest"), "skipped");
    const posts = calls.filter((call) => call.path.endsWith("/api/chat"));
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0].body, {
      model: "qwen3:8b",
      messages: [],
      keep_alive: "30m",
      think: false,
      stream: false,
    });
    assert.equal(calls.some((call) => call.path.includes("/api/embed")), false);
  } finally {
    globalThis.fetch = originalFetch;
    const engine = await import("../dist/index.js");
    engine.resetModelProvider();
    engine.resetOllamaHttpClient();
  }
});

test("warmChatModel skips a model /api/ps already lists", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(
      JSON.stringify({ models: [{ name: "qwen3:8b:latest", model: "qwen3:8b:latest" }] }),
      { status: 200 },
    );
  };
  try {
    const engine = await import("../dist/index.js");
    engine.resetOllamaHttpClient();
    const client = new engine.OllamaClient("http://ollama.test");
    assert.equal(await client.warmChatModel("qwen3:8b"), "skipped");
    assert.equal(calls.some((url) => url.endsWith("/api/chat")), false);
    assert.equal(await client.warmChatModel("qwen3:8b"), "skipped");
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    const engine = await import("../dist/index.js");
    engine.resetModelProvider();
    engine.resetOllamaHttpClient();
  }
});

test("warmChatModel failure stays silent and can be retried", async () => {
  const originalFetch = globalThis.fetch;
  let down = true;
  globalThis.fetch = async (url) => {
    if (down) throw new Error("connect ECONNREFUSED");
    if (String(url).endsWith("/api/ps")) return new Response(JSON.stringify({ models: [] }), { status: 200 });
    return new Response(JSON.stringify({ done: true, done_reason: "load" }), { status: 200 });
  };
  try {
    const engine = await import("../dist/index.js");
    engine.resetOllamaHttpClient();
    const client = new engine.OllamaClient("http://ollama.test");
    assert.equal(await client.warmChatModel("qwen3:8b"), "failed");
    down = false;
    assert.equal(await client.warmChatModel("qwen3:8b"), "warmed");
  } finally {
    globalThis.fetch = originalFetch;
    const engine = await import("../dist/index.js");
    engine.resetModelProvider();
    engine.resetOllamaHttpClient();
  }
});

test("a fresh profile's agentic model is qwen3:8b, not the first tag", async () => {
  const engine = await import("../dist/index.js");
  const tags = ["nomic-embed-text", "llama3.2:3b", "qwen3:4b", "qwen3:8b"];
  assert.equal(engine.pickChatModel(tags, undefined, { agentic: true, envModel: undefined }), "qwen3:8b");
  assert.equal(engine.pickChatModel(tags, undefined, { envModel: undefined }), "qwen3:4b");
  assert.equal(engine.pickChatModel(tags, "llama3.2:3b", { agentic: true, envModel: undefined }), "llama3.2:3b");
  assert.equal(engine.pickChatModel(["nomic-embed-text"], undefined, { agentic: true, envModel: undefined }), null);

  const previous = process.env.CHAT_MODEL;
  delete process.env.CHAT_MODEL;
  setModelProvider(new FakeModelProvider({ models: tags }));
  try {
    assert.equal(await engine.resolveChatModel(undefined, { agentic: true }), "qwen3:8b");
    assert.equal(await engine.resolveChatModel(), "qwen3:4b");
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

test("Ollama coming back rewarms unless /api/ps still lists the model", async () => {
  const calls = [];
  let resident = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const path = String(url);
    calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (path.endsWith("/api/ps")) {
      return new Response(JSON.stringify({ models: resident }), { status: 200 });
    }
    return new Response(JSON.stringify({ done: true, done_reason: "load" }), { status: 200 });
  };
  try {
    const engine = await import("../dist/index.js");
    engine.resetOllamaHttpClient();
    const client = new engine.OllamaClient("http://ollama.test");
    assert.equal(await client.warmChatModel("qwen3:8b"), "warmed");
    assert.equal(await client.warmChatModel("qwen3:8b"), "skipped");
    client.forgetWarmedChatModels();
    resident = [{ name: "qwen3:8b:latest", model: "qwen3:8b:latest" }];
    assert.equal(await client.warmChatModel("qwen3:8b"), "skipped");
    client.forgetWarmedChatModels();
    resident = [];
    assert.equal(await client.warmChatModel("qwen3:8b"), "warmed");
    const posts = calls.filter((call) => call.path.endsWith("/api/chat"));
    assert.equal(posts.length, 2);
    assert.equal(posts.every((call) => call.body.model === "qwen3:8b"), true);
    assert.equal(await client.warmChatModel("nomic-embed-text"), "skipped");
  } finally {
    globalThis.fetch = originalFetch;
    const engine = await import("../dist/index.js");
    engine.resetModelProvider();
    engine.resetOllamaHttpClient();
  }
});
