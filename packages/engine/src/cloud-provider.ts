// BYOK cloud escalation transport (ADR-0002). One CloudProvider implements the
// ModelProvider chat + streaming seam over four request shapes:
//   - "openai-compat"  → POST {base}/chat/completions           (OpenAI schema, SSE)
//   - "azure-openai"   → POST {base}/openai/deployments/{d}/...  (OpenAI schema, api-key header)
//   - "anthropic"      → POST {base}/messages                    (Messages API, SSE)
//   - "bedrock"        → POST .../model/{id}/converse            (Converse, SigV4 via aws4fetch)
//
// HARD boundaries this module enforces:
//   * embed() THROWS — cloud is never used for embeddings; retrieval stays local.
//   * No key is stored here. The main process decrypts a safeStorage blob and
//     hands the secret in via `credentials`; the engine treats it as opaque.
//   * `fetchImpl` is injectable so adapter tests run against a fake fetch — no network.
//
// Cost surfacing (ADR-0002): providers that report usage/cost do so via
// `callbacks.onUsage`; we NEVER fabricate token counts or a price.

import type {
  ChatMessage,
  ChatStreamCallbacks,
  ChatUsage,
  ModelProvider,
} from "./model-provider.js";

export type ProviderKind = "openai-compat" | "anthropic" | "azure-openai" | "bedrock";

/** Secret material — main-process only; never persisted in plaintext, never sent to the renderer. */
export interface CloudCredentials {
  /** openai-compat (Bearer), anthropic (x-api-key), azure-openai (api-key). */
  apiKey?: string;
  /** bedrock SigV4. */
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
}

/** Fully-resolved transport config (includes secrets). Built in the main process per turn. */
export interface CloudProviderConfig {
  kind: ProviderKind;
  /** Base URL (all presets ship an editable default; bedrock derives from region when blank). */
  baseUrl: string;
  model: string;
  /** openai-compat auth header name; default "Authorization" (sent as `Bearer <key>`). */
  authHeader?: string;
  extraHeaders?: Record<string, string>;
  /** Extra request-body fields (e.g. OpenRouter `{ usage: { include: true } }` to get cost). */
  extraBody?: Record<string, unknown>;
  /** azure-openai api-version query param / anthropic-version header. */
  apiVersion?: string;
  /** azure-openai deployment name (defaults to model). */
  deployment?: string;
  /** bedrock region (defaults to us-east-1). */
  region?: string;
  /** Output cap — anthropic requires it; bedrock/others use it as a ceiling. */
  maxTokens?: number;
  credentials?: CloudCredentials;
  /** Injectable transport for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

function trimSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

async function ensureOk(r: Response, label: string): Promise<void> {
  if (r.ok) return;
  const body = await r.text().catch(() => "");
  // Prefix "Cloud " so the IPC error mapper surfaces it verbatim instead of
  // mistaking a cloud HTTP error for a failed local Ollama request.
  throw new Error(`Cloud ${label} request failed (HTTP ${r.status}): ${body.slice(0, 300)}`);
}

interface ParsedEvent {
  delta?: string;
  usage?: ChatUsage;
}

function parseOpenAiEvent(json: Record<string, unknown>): ParsedEvent {
  const choices = json.choices as Array<{ delta?: { content?: string } }> | undefined;
  const delta = choices?.[0]?.delta?.content;
  const u = json.usage as
    | { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost?: number }
    | undefined;
  const out: ParsedEvent = {};
  if (typeof delta === "string" && delta.length > 0) out.delta = delta;
  if (u) {
    out.usage = {
      promptTokens: u.prompt_tokens,
      completionTokens: u.completion_tokens,
      totalTokens: u.total_tokens,
      costUsd: typeof u.cost === "number" ? u.cost : undefined,
    };
  }
  return out;
}

function parseAnthropicEvent(json: Record<string, unknown>): ParsedEvent {
  const type = json.type as string | undefined;
  if (type === "content_block_delta") {
    const delta = json.delta as { type?: string; text?: string } | undefined;
    if (delta?.type === "text_delta" && typeof delta.text === "string") return { delta: delta.text };
    return {};
  }
  if (type === "message_start") {
    const usage = (json.message as { usage?: { input_tokens?: number } } | undefined)?.usage;
    if (usage) return { usage: { promptTokens: usage.input_tokens } };
    return {};
  }
  if (type === "message_delta") {
    const usage = json.usage as { output_tokens?: number } | undefined;
    if (usage) return { usage: { completionTokens: usage.output_tokens } };
    return {};
  }
  return {};
}

/** ModelProvider over a BYOK cloud endpoint. Chat + streaming only; embeddings refused. */
export class CloudProvider implements ModelProvider {
  constructor(private readonly cfg: CloudProviderConfig) {}

  private get fetchImpl(): typeof fetch {
    return this.cfg.fetchImpl ?? fetch;
  }

  // ---- ModelProvider seam -----------------------------------------------------

  async isReachable(): Promise<boolean> {
    try {
      await this.listModels();
      return true;
    } catch {
      return false;
    }
  }

  async embed(): Promise<number[][]> {
    // Load-bearing refusal: escalation NEVER routes embeddings to the cloud —
    // retrieval/grounding stays fully local (ADR-0002, spec "out of scope").
    throw new Error("Cloud providers are not used for embeddings — retrieval stays local.");
  }

  async listModels(): Promise<string[]> {
    // Azure lists base models (not deployments) and Bedrock uses a separate control-plane
    // API; for both, the configured model id is authoritative and entered manually.
    if (this.cfg.kind === "azure-openai" || this.cfg.kind === "bedrock") {
      return this.cfg.model ? [this.cfg.model] : [];
    }
    const url =
      this.cfg.kind === "anthropic"
        ? `${trimSlash(this.cfg.baseUrl)}/models`
        : `${trimSlash(this.cfg.baseUrl)}/models`;
    const headers = this.cfg.kind === "anthropic" ? this.anthropicHeaders() : this.oaiHeaders();
    const r = await this.fetchImpl(url, { headers });
    await ensureOk(r, "models");
    const j = (await r.json()) as { data?: Array<{ id?: string }> };
    return (j.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
  }

  async chat(model: string, messages: ChatMessage[]): Promise<string> {
    if (this.cfg.kind === "bedrock") return this.bedrockChat(model, messages);
    // Cloud escalation always has a streaming path; accumulate it for the non-stream caller.
    return this.chatStream(model, messages);
  }

  async chatStream(
    model: string,
    messages: ChatMessage[],
    callbacks?: ChatStreamCallbacks,
  ): Promise<string> {
    switch (this.cfg.kind) {
      case "anthropic":
        return this.anthropicStream(model, messages, callbacks);
      case "bedrock":
        // Converse-stream is an AWS binary event stream (not SSE); shipping an
        // unverified binary framing parser is out of scope for v1. Fall back to a
        // single Converse call and emit the whole answer as one token.
        return this.bedrockChat(model, messages, callbacks);
      default:
        return this.openaiStream(model, messages, callbacks);
    }
  }

  // ---- OpenAI-compatible (+ Azure) --------------------------------------------

  private oaiUrl(path: string): string {
    if (this.cfg.kind === "azure-openai") {
      const dep = this.cfg.deployment || this.cfg.model;
      const ver = this.cfg.apiVersion || "2024-10-21";
      return `${trimSlash(this.cfg.baseUrl)}/openai/deployments/${encodeURIComponent(dep)}/${path}?api-version=${encodeURIComponent(ver)}`;
    }
    return `${trimSlash(this.cfg.baseUrl)}/${path}`;
  }

  private oaiHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      "content-type": "application/json",
      ...(this.cfg.extraHeaders ?? {}),
    };
    const key = this.cfg.credentials?.apiKey ?? "";
    if (this.cfg.kind === "azure-openai") {
      h["api-key"] = key;
    } else {
      const name = this.cfg.authHeader || "Authorization";
      h[name] = name.toLowerCase() === "authorization" ? `Bearer ${key}` : key;
    }
    return h;
  }

  private async openaiStream(
    model: string,
    messages: ChatMessage[],
    callbacks?: ChatStreamCallbacks,
  ): Promise<string> {
    const body: Record<string, unknown> = {
      model,
      messages,
      stream: true,
      ...(this.cfg.extraBody ?? {}),
    };
    // Ask for usage in the terminal SSE chunk (OpenAI/OpenRouter/most compat hosts).
    // Azure gates this behind newer api-versions and errors on older ones, so skip it there.
    if (this.cfg.kind !== "azure-openai") body.stream_options = { include_usage: true };

    const r = await this.fetchImpl(this.oaiUrl("chat/completions"), {
      method: "POST",
      headers: this.oaiHeaders(),
      body: JSON.stringify(body),
    });
    await ensureOk(r, "chat/completions");
    return this.consumeSse(r, callbacks, parseOpenAiEvent);
  }

  // ---- Anthropic Messages -----------------------------------------------------

  private anthropicHeaders(): Record<string, string> {
    return {
      "content-type": "application/json",
      "x-api-key": this.cfg.credentials?.apiKey ?? "",
      "anthropic-version": this.cfg.apiVersion || "2023-06-01",
      ...(this.cfg.extraHeaders ?? {}),
    };
  }

  private anthropicStream(
    model: string,
    messages: ChatMessage[],
    callbacks?: ChatStreamCallbacks,
  ): Promise<string> {
    // Anthropic carries system prompts as a top-level param, not a message role.
    const system = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const msgs = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }));
    const body: Record<string, unknown> = {
      model,
      max_tokens: this.cfg.maxTokens ?? 4096,
      messages: msgs,
      stream: true,
    };
    if (system) body.system = system;

    return this.fetchImpl(`${trimSlash(this.cfg.baseUrl)}/messages`, {
      method: "POST",
      headers: this.anthropicHeaders(),
      body: JSON.stringify(body),
    }).then(async (r) => {
      await ensureOk(r, "messages");
      return this.consumeSse(r, callbacks, parseAnthropicEvent);
    });
  }

  // ---- Amazon Bedrock (Converse, SigV4) ---------------------------------------

  private async bedrockChat(
    model: string,
    messages: ChatMessage[],
    callbacks?: ChatStreamCallbacks,
  ): Promise<string> {
    // Dynamic import keeps aws4fetch off the hot path for the common (OpenAI/Anthropic) kinds.
    const { AwsClient } = await import("aws4fetch");
    const region = this.cfg.region || "us-east-1";
    const base = this.cfg.baseUrl?.trim()
      ? trimSlash(this.cfg.baseUrl)
      : `https://bedrock-runtime.${region}.amazonaws.com`;
    const url = `${base}/model/${encodeURIComponent(model)}/converse`;

    const system = messages
      .filter((m) => m.role === "system")
      .map((m) => ({ text: m.content }));
    const msgs = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: [{ text: m.content }] }));
    const body: Record<string, unknown> = {
      messages: msgs,
      inferenceConfig: { maxTokens: this.cfg.maxTokens ?? 4096 },
    };
    if (system.length > 0) body.system = system;

    const aws = new AwsClient({
      accessKeyId: this.cfg.credentials?.accessKeyId ?? "",
      secretAccessKey: this.cfg.credentials?.secretAccessKey ?? "",
      sessionToken: this.cfg.credentials?.sessionToken,
      service: "bedrock",
      region,
    });
    // sign() returns a signed Request we can hand to the (injectable) fetch — this
    // keeps SigV4 real in tests (WebCrypto) while the network call stays faked.
    const signed = await aws.sign(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const r = await this.fetchImpl(signed);
    await ensureOk(r, "converse");
    const j = (await r.json()) as {
      output?: { message?: { content?: Array<{ text?: string }> } };
      usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
    };
    const text =
      j.output?.message?.content
        ?.map((c) => c.text)
        .filter((t): t is string => typeof t === "string")
        .join("") ?? "";
    if (text) callbacks?.onToken?.(text);
    if (j.usage) {
      callbacks?.onUsage?.({
        promptTokens: j.usage.inputTokens,
        completionTokens: j.usage.outputTokens,
        totalTokens: j.usage.totalTokens,
      });
    }
    return text;
  }

  // ---- Shared SSE consumer ----------------------------------------------------

  private async consumeSse(
    r: Response,
    callbacks: ChatStreamCallbacks | undefined,
    parse: (json: Record<string, unknown>) => ParsedEvent,
  ): Promise<string> {
    // No readable body (some runtimes/mocks): fall back to a single JSON parse.
    if (!r.body) {
      const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      const { delta, usage } = parse(j);
      if (delta) callbacks?.onToken?.(delta);
      if (usage) callbacks?.onUsage?.(finalizeUsage(usage));
      return delta ?? "";
    }

    let full = "";
    let usage: ChatUsage | undefined;
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "" || data === "[DONE]") continue;
        let json: Record<string, unknown>;
        try {
          json = JSON.parse(data) as Record<string, unknown>;
        } catch {
          continue;
        }
        const ev = parse(json);
        if (ev.delta) {
          full += ev.delta;
          callbacks?.onToken?.(ev.delta);
        }
        if (ev.usage) usage = { ...usage, ...ev.usage };
      }
    }
    if (usage) callbacks?.onUsage?.(finalizeUsage(usage));
    return full;
  }
}

/** Fill totalTokens from prompt+completion when the provider reported them separately. */
function finalizeUsage(u: ChatUsage): ChatUsage {
  if (
    u.totalTokens === undefined &&
    typeof u.promptTokens === "number" &&
    typeof u.completionTokens === "number"
  ) {
    return { ...u, totalTokens: u.promptTokens + u.completionTokens };
  }
  return u;
}

// ---- Static preset registry (no secrets) ------------------------------------
// Ships with the app; the settings UI reads it to pre-fill the add-provider form.
// Every base URL is user-editable. VERIFIED against live endpoints 2026-07-08.

/** UI-facing preset metadata. Contains NO keys and never will. */
export interface ProviderPreset {
  id: string;
  label: string;
  kind: ProviderKind;
  /** Editable default base URL. Empty = user must supply (custom / azure / bedrock). */
  baseUrl: string;
  authHeader?: string;
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  apiVersion?: string;
  /** Can we GET {base}/models to offer a picker? Otherwise the model id is typed. */
  supportsModelList: boolean;
  /** Extra required config fields beyond key + model (drives the settings form). */
  needs?: Array<"baseUrl" | "deployment" | "apiVersion" | "region" | "awsKeys">;
  /** One-line UI hint. */
  note?: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: "openai", label: "OpenAI", kind: "openai-compat", baseUrl: "https://api.openai.com/v1", supportsModelList: true },
  { id: "openrouter", label: "OpenRouter", kind: "openai-compat", baseUrl: "https://openrouter.ai/api/v1", supportsModelList: true, extraBody: { usage: { include: true } }, note: "Returns real per-call cost in USD." },
  { id: "gemini", label: "Google Gemini (OpenAI-compat)", kind: "openai-compat", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", supportsModelList: true },
  { id: "mistral", label: "Mistral", kind: "openai-compat", baseUrl: "https://api.mistral.ai/v1", supportsModelList: true },
  { id: "xai", label: "xAI (Grok)", kind: "openai-compat", baseUrl: "https://api.x.ai/v1", supportsModelList: true },
  { id: "deepseek", label: "DeepSeek", kind: "openai-compat", baseUrl: "https://api.deepseek.com/v1", supportsModelList: true },
  { id: "cohere", label: "Cohere (compat)", kind: "openai-compat", baseUrl: "https://api.cohere.ai/compatibility/v1", supportsModelList: true },
  { id: "groq", label: "Groq", kind: "openai-compat", baseUrl: "https://api.groq.com/openai/v1", supportsModelList: true },
  { id: "together", label: "Together AI", kind: "openai-compat", baseUrl: "https://api.together.xyz/v1", supportsModelList: true },
  { id: "fireworks", label: "Fireworks", kind: "openai-compat", baseUrl: "https://api.fireworks.ai/inference/v1", supportsModelList: true },
  { id: "deepinfra", label: "DeepInfra", kind: "openai-compat", baseUrl: "https://api.deepinfra.com/v1/openai", supportsModelList: true },
  { id: "cerebras", label: "Cerebras", kind: "openai-compat", baseUrl: "https://api.cerebras.ai/v1", supportsModelList: true },
  { id: "huggingface", label: "Hugging Face (router)", kind: "openai-compat", baseUrl: "https://router.huggingface.co/v1", supportsModelList: true },
  { id: "anthropic", label: "Anthropic", kind: "anthropic", baseUrl: "https://api.anthropic.com/v1", apiVersion: "2023-06-01", supportsModelList: true },
  { id: "azure-openai", label: "Azure OpenAI", kind: "azure-openai", baseUrl: "", apiVersion: "2024-10-21", supportsModelList: false, needs: ["baseUrl", "deployment", "apiVersion"], note: "Base URL = your resource endpoint (https://<resource>.openai.azure.com)." },
  { id: "bedrock", label: "Amazon Bedrock", kind: "bedrock", baseUrl: "", supportsModelList: false, needs: ["region", "awsKeys"], note: "Streaming falls back to a single Converse call in v1." },
  { id: "custom", label: "Custom (OpenAI-compatible)", kind: "openai-compat", baseUrl: "", supportsModelList: true, needs: ["baseUrl"], note: "Any /v1 endpoint: vLLM, LM Studio, llama.cpp, LiteLLM, remote Ollama." },
];
