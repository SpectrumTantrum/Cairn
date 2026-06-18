import { useEffect, useState } from "react";

type IndexStats = Awaited<ReturnType<typeof window.cairn.indexVault>>;
type OllamaStatus = Awaited<ReturnType<typeof window.cairn.checkOllama>>;

interface IndexPanelProps {
  busy: boolean;
  disabled: boolean;
  indexStats: IndexStats | null;
  ollama: OllamaStatus;
  onIndex(lexical: boolean): void;
}

export function IndexPanel({
  busy,
  disabled,
  indexStats,
  ollama,
  onIndex,
}: IndexPanelProps) {
  const [lexical, setLexical] = useState(!ollama.up);

  useEffect(() => {
    setLexical(!ollama.up);
  }, [ollama.up]);

  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <p className="label">Index</p>
          <h2>Build the local cache</h2>
        </div>
        <span className={`status-pill ${indexStats ? "ready" : ""}`}>
          {indexStats ? indexStats.mode : "Not indexed"}
        </span>
      </div>

      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={lexical}
          disabled={busy || disabled}
          onChange={(event) => setLexical(event.target.checked)}
        />
        <span>Lexical only</span>
      </label>

      <button type="button" onClick={() => onIndex(lexical)} disabled={busy || disabled}>
        {busy ? "Indexing..." : "Index Vault"}
      </button>

      {indexStats ? (
        <dl className="stats-grid">
          <div>
            <dt>Files</dt>
            <dd>{indexStats.files}</dd>
          </div>
          <div>
            <dt>Chunks</dt>
            <dd>{indexStats.chunks}</dd>
          </div>
          <div>
            <dt>Embedded</dt>
            <dd>{indexStats.embedded}</dd>
          </div>
          <div>
            <dt>Cached</dt>
            <dd>{indexStats.cached}</dd>
          </div>
        </dl>
      ) : (
        <p className="muted">
          Choose a Markdown vault, then index it. Lexical mode needs no model; hybrid uses local
          Ollama embeddings when available.
        </p>
      )}
    </section>
  );
}
