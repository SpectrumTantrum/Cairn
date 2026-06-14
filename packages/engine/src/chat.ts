// Local chat/generation via Ollama's /api/chat — the "always-on model" (CONTEXT.md).
// Defaults to a Qwen3 chat model; thinking is disabled (think:false) to keep answers clean
// and fast and to sidestep the empty-reasoning-turn brittleness the agent-loop spike
// surfaced. Override with CHAT_MODEL or --model.

import { listModels } from "./embed.ts";

const OLLAMA = process.env.OLLAMA_HOST || "http://localhost:11434";

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
  for (const p of prefer) if (exact(p)) return p; // exact preferred tag wins
  for (const p of prefer) {
    const m = family(p);
    if (m) return m;
  }
  const any = models.find((m) => !/embed/i.test(m)); // any non-embedding model
  if (any) return any;
  throw new Error("no local chat model — `ollama pull qwen3:4b`");
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function chat(model: string, messages: ChatMessage[], think = false): Promise<string> {
  const body: Record<string, unknown> = { model, messages, stream: false };
  if (think === false) body.think = false;

  const post = () =>
    fetch(`${OLLAMA}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  let r = await post();
  if (!r.ok && body.think !== undefined) {
    delete body.think; // some models reject the think field — retry without it
    r = await post();
  }
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`HTTP ${r.status} from /api/chat: ${t.slice(0, 200)}`);
  }
  const j = (await r.json()) as { message?: { content?: string } };
  return stripThinking(j.message?.content ?? "");
}

// Thinking models (e.g. Qwen3) can emit a <think>…</think> reasoning block into the content
// even when think:false isn't honored. Keep only what follows the final </think>; drop any
// stray tags. Guarantees a clean answer regardless of the model/Ollama version.
function stripThinking(s: string): string {
  let out = s;
  const lastClose = out.lastIndexOf("</think>");
  if (lastClose !== -1) out = out.slice(lastClose + "</think>".length);
  return out.replace(/<\/?think>/gi, "").trim();
}
