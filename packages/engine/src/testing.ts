import type { ChatMessage, ChatStreamCallbacks, ModelProvider } from "./model-provider.js";

export { InMemoryIndex } from "./vault-index.js";

export interface FakeModelProviderOpts {
  models?: string[];
  reachable?: boolean;
  embed?: (model: string, input: string[]) => Promise<number[][]>;
  chat?: (model: string, messages: ChatMessage[]) => Promise<string>;
  /**
   * Optional streaming override. When absent, `chatStream` streams the `chat()`
   * result whitespace-token by token — enough to exercise the onToken seam in gates.
   */
  chatStream?: (
    model: string,
    messages: ChatMessage[],
    callbacks?: ChatStreamCallbacks,
  ) => Promise<string>;
}

/** Test adapter for ModelProvider — no HTTP. */
export class FakeModelProvider implements ModelProvider {
  private readonly models: string[];
  private readonly reachable: boolean;
  private readonly embedFn?: FakeModelProviderOpts["embed"];
  private readonly chatFn?: FakeModelProviderOpts["chat"];
  private readonly chatStreamFn?: FakeModelProviderOpts["chatStream"];

  constructor(opts: FakeModelProviderOpts = {}) {
    this.models = opts.models ?? ["qwen3:4b", "test-embedder"];
    this.reachable = opts.reachable ?? true;
    this.embedFn = opts.embed;
    this.chatFn = opts.chat;
    this.chatStreamFn = opts.chatStream;
  }

  async listModels(): Promise<string[]> {
    return this.models;
  }

  async isReachable(): Promise<boolean> {
    return this.reachable;
  }

  async embed(model: string, input: string[]): Promise<number[][]> {
    if (this.embedFn) return this.embedFn(model, input);
    return input.map(() => [1, 0, 0, 0]);
  }

  async chat(model: string, messages: ChatMessage[]): Promise<string> {
    if (this.chatFn) return this.chatFn(model, messages);
    return "Cairn keeps Markdown vaults local and cites source lines [1].";
  }

  async chatStream(
    model: string,
    messages: ChatMessage[],
    callbacks?: ChatStreamCallbacks,
  ): Promise<string> {
    if (this.chatStreamFn) return this.chatStreamFn(model, messages, callbacks);
    const full = await this.chat(model, messages);
    for (const token of full.match(/\S+\s*/g) ?? [full]) callbacks?.onToken?.(token);
    return full;
  }
}
