// Local chat/generation via the ModelProvider seam — the "always-on model" (CONTEXT.md).
// Defaults to a Qwen3 chat model; thinking is disabled (think:false) to keep answers clean
// and fast. Override with CHAT_MODEL or --model.

import { getModelProvider, type ChatMessage } from "./model-provider.js";
import { listModels } from "./embed.js";

export type { ChatMessage };

export async function resolveChatModel(requested?: string): Promise<string> {
  const models = await listModels();
  const exact = (want: string) => models.includes(want);
  const family = (want: string) =>
    models.find((m) => m.split(":")[0] === want.split(":")[0]);

  if (requested) {
    if (!exact(requested) && !family(requested)) {
      throw new Error(`chat model "${requested}" not pulled (have: ${models.join(", ") || "none"})`);
    }
    return exact(requested) ? requested : (family(requested) as string);
  }
  const env = process.env.CHAT_MODEL;
  if (env && (exact(env) || family(env))) return exact(env) ? env : (family(env) as string);

  const prefer = ["qwen3:4b", "qwen3:8b", "qwen3", "llama3.2:3b", "llama3.2"];
  for (const p of prefer) if (exact(p)) return p;
  for (const p of prefer) {
    const m = family(p);
    if (m) return m;
  }
  const any = models.find((m) => !/embed/i.test(m));
  if (any) return any;
  throw new Error("no local chat model — `ollama pull qwen3:4b`");
}

export async function chat(model: string, messages: ChatMessage[], think = false): Promise<string> {
  const raw = await getModelProvider().chat(model, messages, think);
  return stripThinking(raw);
}

function stripThinking(s: string): string {
  let out = s;
  const lastClose = out.lastIndexOf("</think>");
  if (lastClose !== -1) out = out.slice(lastClose + "</think>".length);
  return out.replace(/<\/?think>/gi, "").trim();
}
