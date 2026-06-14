// Local embeddings via Ollama's /api/embed — the locked, language-agnostic path
// (ADR-0001/0002). Default app-wide embedder is Qwen3-Embedding-0.6B (1024-dim);
// override with EMBED_MODEL or --embedder. Ported from spikes/hybrid-sqlite.
//
// NOTE (this session's finding): the rag-quality eval that "validated" this embedder
// was lexically leaky (a TF-IDF baseline beat it). Treat dense retrieval here as
// unproven-quality until the rebuilt eval lands — see docs/spike-verdicts-correction.md.

const OLLAMA = process.env.OLLAMA_HOST || "http://localhost:11434";
export const DEFAULT_EMBED = "qwen3-embedding:0.6b";

export async function listModels(): Promise<string[]> {
  const r = await fetch(`${OLLAMA}/api/tags`);
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${OLLAMA}/api/tags`);
  const j = (await r.json()) as { models?: { name: string }[] };
  return (j.models ?? []).map((m) => m.name);
}

export async function ollamaUp(): Promise<boolean> {
  try {
    await listModels();
    return true;
  } catch {
    return false;
  }
}

function hasModel(models: string[], want: string): boolean {
  return models.some((m) => m === want || m.split(":")[0] === want.split(":")[0]);
}

// Resolve the embedder: an explicit request wins; else the locked default; else any
// embedding-capable model present (best-effort). Throws (with a fix-it hint) if none.
export async function resolveEmbedder(requested?: string): Promise<string> {
  const models = await listModels();
  if (requested) {
    if (!hasModel(models, requested)) {
      throw new Error(`embedder "${requested}" not pulled (have: ${models.join(", ") || "none"})`);
    }
    return requested;
  }
  if (hasModel(models, DEFAULT_EMBED)) return DEFAULT_EMBED;
  const guess = models.find((m) => /embed/i.test(m));
  if (guess) return guess;
  throw new Error(
    `no embedder available — \`ollama pull ${DEFAULT_EMBED}\`, or index with --lexical (no model needed)`,
  );
}

export async function embed(model: string, input: string[]): Promise<number[][]> {
  const r = await fetch(`${OLLAMA}/api/embed`, {
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
