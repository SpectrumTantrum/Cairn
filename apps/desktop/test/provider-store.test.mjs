// ProviderStore gate (ADR-0002). No Electron: a fake SecretCrypto stands in for
// safeStorage and the store lives in a tmp dir. Proves the security invariants:
//   * list() returns metadata with `hasKey` but NEVER key material or the cipher;
//   * the plaintext key is never written to disk;
//   * resolveConfig decrypts the stored secret (main-process only);
//   * an edit without a new secret keeps the stored key;
//   * saving a secret when encryption is unavailable is refused.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const { ProviderStore, testConnection } = await import("../out-test/provider-store.js");

/**
 * Reversible fake "encryption" standing in for Electron safeStorage.
 *
 * This actually transforms the plaintext bytes (fixed multi-byte XOR key), unlike
 * a `"enc:" + plain` prefix wrapper: prefixing leaves the plaintext bytes intact
 * as a substring of the "ciphertext", so once the store base64-encodes that for
 * disk, the plaintext substring is gone from the on-disk text for the SAME reason
 * an identity/no-op cipher would be — base64 alone obscures ASCII substrings. That
 * makes the "plaintext never on disk" assertion pass even when the fake cipher
 * does nothing, which is a false sense of security. XOR-ing the bytes means the
 * assertion can only pass when encrypt() actually did something, and the round
 * trip below proves it's still reversible.
 */
const FAKE_CIPHER_KEY = Buffer.from([0x5a, 0xc3, 0x18, 0x7e, 0x91, 0x2f, 0xd4]);

function xorBytes(buf, key) {
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i += 1) out[i] = buf[i] ^ key[i % key.length];
  return out;
}

function fakeCrypto(available = true) {
  return {
    available: () => available,
    encrypt: (plain) => xorBytes(Buffer.from(plain, "utf8"), FAKE_CIPHER_KEY),
    decrypt: (cipher) => xorBytes(cipher, FAKE_CIPHER_KEY).toString("utf8"),
  };
}

function makeStore(crypto = fakeCrypto()) {
  const dir = mkdtempSync(join(tmpdir(), "cairn-provider-store-"));
  const filePath = join(dir, "cloud-providers.json");
  return { store: new ProviderStore({ filePath, crypto }), filePath, dir };
}

test("save then list returns metadata with hasKey but no key material", () => {
  const { store, dir } = makeStore();
  try {
    const meta = store.save({
      presetId: "openai",
      label: "My OpenAI",
      kind: "openai-compat",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      secret: { apiKey: "sk-secret-123" },
    });
    assert.equal(meta.hasKey, true);
    assert.equal("apiKey" in meta, false);
    assert.equal("secretCipher" in meta, false);
    assert.equal("credentials" in meta, false);

    const list = store.list();
    assert.equal(list.length, 1);
    const json = JSON.stringify(list);
    assert.equal(json.includes("sk-secret-123"), false);
    assert.equal(json.includes("secretCipher"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the plaintext key is never written to the store file", () => {
  const { store, filePath, dir } = makeStore();
  const apiKey = "sk-ant-plaintext-xyz";
  try {
    store.save({
      presetId: "anthropic",
      label: "Claude",
      kind: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      model: "claude-3-5-sonnet",
      secret: { apiKey },
    });
    const onDisk = readFileSync(filePath, "utf8");
    assert.equal(onDisk.includes(apiKey), false);

    // Positive control: the fake cipher itself is reversible, so this isn't
    // passing merely because the cipher is broken/one-way.
    const crypto = fakeCrypto();
    assert.equal(crypto.decrypt(crypto.encrypt(apiKey)), apiKey);

    // Guard against a no-op/identity cipher hiding behind the base64 disk
    // encoding: if `secretCipher` were simply base64(plaintext-json), the
    // substring check above would still have passed, giving false confidence.
    const parsed = JSON.parse(onDisk);
    const secretCipher = parsed.providers[0].secretCipher;
    const plainSecretJson = JSON.stringify({ apiKey });
    const noopCipherWouldProduce = Buffer.from(plainSecretJson, "utf8").toString("base64");
    assert.notEqual(secretCipher, noopCipherWouldProduce);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveConfig decrypts the stored secret for transport (main-process only)", () => {
  const { store, dir } = makeStore();
  try {
    const meta = store.save({
      presetId: "openrouter",
      label: "OpenRouter",
      kind: "openai-compat",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "openai/gpt-4o-mini",
      extraBody: { usage: { include: true } },
      secret: { apiKey: "sk-or-abc" },
    });
    const config = store.resolveConfig(meta.id);
    assert.equal(config.credentials.apiKey, "sk-or-abc");
    assert.equal(config.baseUrl, "https://openrouter.ai/api/v1");
    assert.deepEqual(config.extraBody, { usage: { include: true } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("editing without a new secret keeps the stored key", () => {
  const { store, dir } = makeStore();
  try {
    const meta = store.save({
      presetId: "openai",
      label: "OpenAI",
      kind: "openai-compat",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o",
      secret: { apiKey: "sk-keep-me" },
    });
    const edited = store.save({
      id: meta.id,
      presetId: "openai",
      label: "OpenAI (renamed)",
      kind: "openai-compat",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      // no secret supplied
    });
    assert.equal(edited.hasKey, true);
    assert.equal(edited.label, "OpenAI (renamed)");
    assert.equal(store.resolveConfig(meta.id).credentials.apiKey, "sk-keep-me");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("delete removes the provider; resolveConfig then throws", () => {
  const { store, dir } = makeStore();
  try {
    const meta = store.save({
      presetId: "groq",
      label: "Groq",
      kind: "openai-compat",
      baseUrl: "https://api.groq.com/openai/v1",
      model: "llama-3.3-70b",
      secret: { apiKey: "gsk-1" },
    });
    assert.equal(store.has(meta.id), true);
    store.delete(meta.id);
    assert.equal(store.has(meta.id), false);
    assert.equal(store.list().length, 0);
    assert.throws(() => store.resolveConfig(meta.id), /no longer configured/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saving a key is refused when secure storage is unavailable", () => {
  const { store, dir } = makeStore(fakeCrypto(false));
  try {
    assert.throws(
      () =>
        store.save({
          presetId: "openai",
          label: "OpenAI",
          kind: "openai-compat",
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-4o",
          secret: { apiKey: "sk-x" },
        }),
      /Secure key storage is unavailable/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("testConnection reports azure/bedrock as unverified without any network call", async () => {
  const { store, dir } = makeStore();
  try {
    const azure = await testConnection(
      store.configFromInput({
        presetId: "azure-openai",
        label: "Azure",
        kind: "azure-openai",
        baseUrl: "https://res.openai.azure.com",
        model: "gpt-4o",
        deployment: "gpt4o",
        apiVersion: "2024-10-21",
        secret: { apiKey: "az" },
      }),
    );
    assert.equal(azure.ok, true);
    assert.equal(azure.unverified, true);

    const bedrock = await testConnection(
      store.configFromInput({
        presetId: "bedrock",
        label: "Bedrock",
        kind: "bedrock",
        baseUrl: "",
        model: "anthropic.claude-3-sonnet",
        region: "us-east-1",
        secret: { accessKeyId: "AKIA", secretAccessKey: "s" },
      }),
    );
    assert.equal(bedrock.ok, true);
    assert.equal(bedrock.unverified, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
