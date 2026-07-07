// Local embeddings via the ModelProvider seam (ADR-0001/0002). Default app-wide embedder is
// Qwen3-Embedding-0.6B (1024-dim); override with EMBED_MODEL or --embedder.

import { getModelProvider } from "./model-provider.js";

export const DEFAULT_EMBED = "qwen3-embedding:0.6b";
const QWEN3_QUERY_TASK = "Given a question, retrieve relevant passages from the user's notes that best answer it.";

export async function listModels(): Promise<string[]> {
  return getModelProvider().listModels();
}

export async function ollamaUp(): Promise<boolean> {
  return getModelProvider().isReachable();
}

function hasModel(models: string[], want: string): boolean {
  return models.some((m) => m === want || m.split(":")[0] === want.split(":")[0]);
}

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
  return getModelProvider().embed(model, input);
}

export function formatQueryForEmbedding(model: string, query: string): string {
  if (!/qwen3.*embed/i.test(model)) return query;
  return `Instruct: ${QWEN3_QUERY_TASK}\nQuery: ${query}`;
}
