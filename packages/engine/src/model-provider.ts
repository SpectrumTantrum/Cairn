// Local model transport seam (ADR-0002): Ollama today, BYOK cloud adapters later.
// HTTP only — no Electron/DOM. Callers use getModelProvider() or inject via setModelProvider() in tests.

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Streaming hooks for token-by-token chat output. `onToken` fires once per delta
 * as the model produces it; the returned Promise still resolves to the full text.
 * The callback shape is deliberately a plain function so an Electron IPC bridge can
 * forward each token over a channel (`onToken: (t) => webContents.send(chan, t)`)
 * without the engine knowing anything about IPC — the seam stays HTTP/DOM-free.
 */
export interface ChatStreamCallbacks {
  onToken?: (token: string) => void;
}

export interface ModelProvider {
  listModels(): Promise<string[]>;
  isReachable(): Promise<boolean>;
  embed(model: string, input: string[]): Promise<number[][]>;
  chat(model: string, messages: ChatMessage[], think?: boolean): Promise<string>;
  /**
   * Optional streaming variant. Providers that implement it emit tokens via
   * `callbacks.onToken` and resolve to the accumulated text. Optional so existing
   * adapters keep compiling; callers should fall back to `chat()` when absent.
   */
  chatStream?(
    model: string,
    messages: ChatMessage[],
    callbacks?: ChatStreamCallbacks,
    think?: boolean,
  ): Promise<string>;
}

export class OllamaClient implements ModelProvider {
  constructor(private readonly baseUrl = process.env.OLLAMA_HOST || "http://localhost:11434") {}

  async listModels(): Promise<string[]> {
    const r = await fetch(`${this.baseUrl}/api/tags`);
    if (!r.ok) throw new Error(`HTTP ${r.status} from ${this.baseUrl}/api/tags`);
    const j = (await r.json()) as { models?: { name: string }[] };
    return (j.models ?? []).map((m) => m.name);
  }

  async isReachable(): Promise<boolean> {
    try {
      await this.listModels();
      return true;
    } catch {
      return false;
    }
  }

  async embed(model: string, input: string[]): Promise<number[][]> {
    const r = await fetch(`${this.baseUrl}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, input }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      throw new Error(`HTTP ${r.status} from /api/embed: ${body.slice(0, 200)}`);
    }
    const j = (await r.json()) as { embeddings?: number[][] };
    if (!j.embeddings || j.embeddings.length === 0) throw new Error("no embeddings in response");
    return j.embeddings;
  }

  async chat(model: string, messages: ChatMessage[], think = false): Promise<string> {
    const body: Record<string, unknown> = { model, messages, stream: false };
    if (think === false) body.think = false;

    const post = () =>
      fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    let r = await post();
    if (!r.ok && body.think !== undefined) {
      delete body.think;
      r = await post();
    }
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      throw new Error(`HTTP ${r.status} from /api/chat: ${t.slice(0, 200)}`);
    }
    const j = (await r.json()) as { message?: { content?: string } };
    return j.message?.content ?? "";
  }

  async chatStream(
    model: string,
    messages: ChatMessage[],
    callbacks?: ChatStreamCallbacks,
    think = false,
  ): Promise<string> {
    const body: Record<string, unknown> = { model, messages, stream: true };
    if (think === false) body.think = false;

    const post = () =>
      fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    let r = await post();
    if (!r.ok && body.think !== undefined) {
      delete body.think;
      r = await post();
    }
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      throw new Error(`HTTP ${r.status} from /api/chat (stream): ${t.slice(0, 200)}`);
    }

    const emit = (line: string, acc: { full: string }) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let obj: { message?: { content?: string }; done?: boolean };
      try {
        obj = JSON.parse(trimmed);
      } catch {
        return;
      }
      const tok = obj.message?.content;
      if (tok) {
        acc.full += tok;
        callbacks?.onToken?.(tok);
      }
    };

    // Ollama streams newline-delimited JSON objects. If the runtime gave us no
    // readable body, fall back to a single non-streamed parse.
    if (!r.body) {
      const j = (await r.json()) as { message?: { content?: string } };
      const c = j.message?.content ?? "";
      if (c) callbacks?.onToken?.(c);
      return c;
    }

    const acc = { full: "" };
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        emit(buf.slice(0, nl), acc);
        buf = buf.slice(nl + 1);
      }
    }
    emit(buf, acc);
    return acc.full;
  }
}

let defaultProvider: ModelProvider | null = null;

export function getModelProvider(): ModelProvider {
  if (!defaultProvider) defaultProvider = new OllamaClient();
  return defaultProvider;
}

export function setModelProvider(provider: ModelProvider): void {
  defaultProvider = provider;
}

export function resetModelProvider(): void {
  defaultProvider = null;
}
