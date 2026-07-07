import assert from "node:assert/strict";
import { after, before, test } from "node:test";

let setModelProvider;
let resetModelProvider;
let FakeModelProvider;
let getModelProvider;

before(async () => {
  const engine = await import("../dist/index.js");
  const testing = await import("../dist/testing.js");
  setModelProvider = engine.setModelProvider;
  resetModelProvider = engine.resetModelProvider;
  getModelProvider = engine.getModelProvider;
  FakeModelProvider = testing.FakeModelProvider;
});

after(() => {
  resetModelProvider();
});

test("FakeModelProvider reports reachability from opts", async () => {
  setModelProvider(new FakeModelProvider({ reachable: false, models: [] }));
  assert.equal(await getModelProvider().isReachable(), false);

  setModelProvider(new FakeModelProvider({ models: ["qwen3:4b"] }));
  assert.equal(await getModelProvider().isReachable(), true);
  assert.deepEqual(await getModelProvider().listModels(), ["qwen3:4b"]);
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
