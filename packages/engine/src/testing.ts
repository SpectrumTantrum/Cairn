import type {
  AgentMessage,
  ChatMessage,
  ChatStreamCallbacks,
  ModelProvider,
  ToolSchema,
  ToolTurn,
} from "./model-provider.js";

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
  /**
   * Optional tool-calling override for the agent write-loop (ADR-0008). When
   * absent, the provider reports NO tool support (chatWithTools is undefined), so
   * gates can assert the loop degrades cleanly; supply a scripted turn-by-turn fn
   * to exercise the loop. It receives the 1-based turn index so a script can drive
   * a multi-step run and then stop.
   */
  chatWithTools?: (
    model: string,
    messages: AgentMessage[],
    tools: ToolSchema[],
    turn: number,
  ) => Promise<ToolTurn>;
}

/** Test adapter for ModelProvider — no HTTP. */
export class FakeModelProvider implements ModelProvider {
  private readonly models: string[];
  private readonly reachable: boolean;
  private readonly embedFn?: FakeModelProviderOpts["embed"];
  private readonly chatFn?: FakeModelProviderOpts["chat"];
  private readonly chatStreamFn?: FakeModelProviderOpts["chatStream"];
  private readonly chatWithToolsFn?: FakeModelProviderOpts["chatWithTools"];
  private toolTurn = 0;
  // Present only when a tool script was supplied — mirrors how a non-tool-capable
  // provider omits the method entirely, so the agent loop's feature-detection is real.
  readonly chatWithTools?: ModelProvider["chatWithTools"];

  constructor(opts: FakeModelProviderOpts = {}) {
    this.models = opts.models ?? ["qwen3:4b", "test-embedder"];
    this.reachable = opts.reachable ?? true;
    this.embedFn = opts.embed;
    this.chatFn = opts.chat;
    this.chatStreamFn = opts.chatStream;
    this.chatWithToolsFn = opts.chatWithTools;
    if (this.chatWithToolsFn) {
      this.chatWithTools = (model, messages, tools) =>
        this.chatWithToolsFn!(model, messages, tools, ++this.toolTurn);
    }
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
