// BYOK cloud-provider key store (ADR-0002). Persists provider CONFIG in the app's
// userData dir with the secret encrypted via an injected `SecretCrypto` (wired to
// Electron safeStorage in production). Hard rules enforced here:
//   * Secrets are NEVER written in plaintext and NEVER leave the main process:
//     `list()` returns metadata with a `hasKey` boolean but no key material.
//   * The store lives in userData, NOT the vault (vaults sync to other machines).
//   * Electron is not imported — the crypto + file path are injected — so this
//     module runs under `node --test` with a fake crypto and a tmp dir.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  CloudProvider,
  PROVIDER_PRESETS,
  type CloudCredentials,
  type CloudProviderConfig,
  type ProviderKind,
} from "@cairn/engine";

/** Reversible secret encryption. Production impl wraps Electron safeStorage. */
export interface SecretCrypto {
  available(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(cipher: Buffer): string;
}

/** On-disk record. `secretCipher` is base64 of encrypt(JSON.stringify(credentials)). */
interface StoredProvider {
  id: string;
  presetId?: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  authHeader?: string;
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  apiVersion?: string;
  deployment?: string;
  region?: string;
  maxTokens?: number;
  secretCipher?: string;
}

interface StoreFile {
  version: 1;
  providers: StoredProvider[];
}

/** Renderer-safe view: no key material, just whether one is stored. */
export interface ProviderMeta {
  id: string;
  presetId?: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  apiVersion?: string;
  deployment?: string;
  region?: string;
  hasKey: boolean;
}

/** Draft from the settings form. `secret` is write-only; omit on edit to keep the stored key. */
export interface ProviderInput {
  id?: string;
  presetId?: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  authHeader?: string;
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  apiVersion?: string;
  deployment?: string;
  region?: string;
  maxTokens?: number;
  secret?: CloudCredentials;
}

export interface TestConnectionResult {
  ok: boolean;
  models?: string[];
  error?: string;
  /** True when the kind can't be verified without spending tokens (Azure/Bedrock). */
  unverified?: boolean;
}

function toMeta(p: StoredProvider): ProviderMeta {
  return {
    id: p.id,
    presetId: p.presetId,
    label: p.label,
    kind: p.kind,
    baseUrl: p.baseUrl,
    model: p.model,
    apiVersion: p.apiVersion,
    deployment: p.deployment,
    region: p.region,
    hasKey: typeof p.secretCipher === "string" && p.secretCipher.length > 0,
  };
}

function hasSecret(c: CloudCredentials | undefined): boolean {
  return !!c && Object.values(c).some((v) => typeof v === "string" && v.length > 0);
}

let idCounter = 0;
function mintId(): string {
  idCounter += 1;
  return `prov_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

export class ProviderStore {
  private readonly filePath: string;
  private readonly crypto: SecretCrypto;
  private cache: StoreFile | null = null;

  constructor(deps: { filePath: string; crypto: SecretCrypto }) {
    this.filePath = deps.filePath;
    this.crypto = deps.crypto;
  }

  /** Metadata only — safe to send to the renderer. Never includes key material. */
  list(): ProviderMeta[] {
    return this.read().providers.map(toMeta);
  }

  has(id: string): boolean {
    return this.read().providers.some((p) => p.id === id);
  }

  /** Create or update a provider. Returns metadata (no secret echoed back). */
  save(input: ProviderInput): ProviderMeta {
    const store = this.read();
    const id = input.id && input.id.length > 0 ? input.id : mintId();
    const existing = store.providers.find((p) => p.id === id);

    let secretCipher = existing?.secretCipher;
    if (hasSecret(input.secret)) {
      if (!this.crypto.available()) {
        throw new Error("Secure key storage is unavailable on this system; cannot save an API key.");
      }
      secretCipher = this.crypto.encrypt(JSON.stringify(input.secret)).toString("base64");
    }

    const record: StoredProvider = {
      id,
      presetId: input.presetId,
      label: input.label,
      kind: input.kind,
      baseUrl: input.baseUrl,
      model: input.model,
      authHeader: input.authHeader,
      extraHeaders: input.extraHeaders,
      extraBody: input.extraBody,
      apiVersion: input.apiVersion,
      deployment: input.deployment,
      region: input.region,
      maxTokens: input.maxTokens,
      secretCipher,
    };

    const next = existing
      ? store.providers.map((p) => (p.id === id ? record : p))
      : [...store.providers, record];
    this.write({ version: 1, providers: next });
    return toMeta(record);
  }

  delete(id: string): void {
    const store = this.read();
    this.write({ version: 1, providers: store.providers.filter((p) => p.id !== id) });
  }

  /**
   * Build a fully-resolved transport config for a STORED provider, decrypting its
   * secret. Main-process only — the returned config carries key material and must
   * never cross the IPC boundary to the renderer.
   */
  resolveConfig(id: string): CloudProviderConfig {
    const record = this.read().providers.find((p) => p.id === id);
    if (!record) throw new Error("That cloud provider is no longer configured.");
    return this.recordToConfig(record, this.decryptSecret(record));
  }

  /** Build a config from an unsaved draft (used to test before saving). */
  configFromInput(input: ProviderInput): CloudProviderConfig {
    return this.recordToConfig(
      {
        id: input.id ?? "draft",
        presetId: input.presetId,
        label: input.label,
        kind: input.kind,
        baseUrl: input.baseUrl,
        model: input.model,
        authHeader: input.authHeader,
        extraHeaders: input.extraHeaders,
        extraBody: input.extraBody,
        apiVersion: input.apiVersion,
        deployment: input.deployment,
        region: input.region,
        maxTokens: input.maxTokens,
      },
      // Prefer the draft's secret; fall back to a previously-stored one on edit.
      hasSecret(input.secret)
        ? input.secret
        : input.id
          ? this.decryptSecret(this.read().providers.find((p) => p.id === input.id))
          : undefined,
    );
  }

  private recordToConfig(record: StoredProvider, credentials?: CloudCredentials): CloudProviderConfig {
    return {
      kind: record.kind,
      baseUrl: record.baseUrl,
      model: record.model,
      authHeader: record.authHeader,
      extraHeaders: record.extraHeaders,
      extraBody: record.extraBody,
      apiVersion: record.apiVersion,
      deployment: record.deployment,
      region: record.region,
      maxTokens: record.maxTokens,
      credentials,
    };
  }

  private decryptSecret(record: StoredProvider | undefined): CloudCredentials | undefined {
    if (!record?.secretCipher) return undefined;
    try {
      const plain = this.crypto.decrypt(Buffer.from(record.secretCipher, "base64"));
      return JSON.parse(plain) as CloudCredentials;
    } catch {
      throw new Error("Stored API key could not be decrypted on this system.");
    }
  }

  private read(): StoreFile {
    if (this.cache) return this.cache;
    if (!existsSync(this.filePath)) {
      this.cache = { version: 1, providers: [] };
      return this.cache;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as StoreFile;
      this.cache = parsed.providers ? parsed : { version: 1, providers: [] };
    } catch {
      this.cache = { version: 1, providers: [] };
    }
    return this.cache;
  }

  private write(store: StoreFile): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(store, null, 2), { encoding: "utf8", mode: 0o600 });
    try {
      chmodSync(this.filePath, 0o600); // tighten perms even if the file pre-existed
    } catch {
      // Best-effort on platforms without POSIX perms.
    }
    this.cache = store;
  }
}

/**
 * Probe a provider config without spending tokens: list models where the kind
 * supports it, otherwise report a validated-but-unverified config. Never sends a
 * chat completion (that would cost money on a "test" click).
 */
export async function testConnection(config: CloudProviderConfig): Promise<TestConnectionResult> {
  const preset = PROVIDER_PRESETS.find(
    (p) => p.kind === config.kind && (p.baseUrl === config.baseUrl || p.kind === "azure-openai" || p.kind === "bedrock"),
  );
  const listable = config.kind === "openai-compat" || config.kind === "anthropic";
  if (!listable) {
    return { ok: true, unverified: true, models: config.model ? [config.model] : [] };
  }
  try {
    const models = await new CloudProvider(config).listModels();
    return { ok: true, models, unverified: preset ? !preset.supportsModelList : false };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
