import { useCallback, useEffect, useMemo, useState } from "react";
import type { AskResult, IndexStats, OllamaStatus, SearchHit } from "../shared/types.js";
import { AskPanel } from "./components/AskPanel";
import { IndexPanel } from "./components/IndexPanel";
import { SearchPanel } from "./components/SearchPanel";
import { SourceViewer } from "./components/SourceViewer";
import { VaultPicker } from "./components/VaultPicker";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function App() {
  const [vaultPath, setVaultPath] = useState<string | null>(null);
  const [indexStats, setIndexStats] = useState<IndexStats | null>(null);
  const [ollama, setOllama] = useState<OllamaStatus>({ up: false, models: [] });
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [askResult, setAskResult] = useState<AskResult | null>(null);
  const [selectedSource, setSelectedSource] = useState<SearchHit | null>(null);
  const [searchSubmitted, setSearchSubmitted] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canQuery = useMemo(() => Boolean(vaultPath && indexStats), [vaultPath, indexStats]);

  useEffect(() => {
    void refreshOllama();
  }, []);

  async function refreshOllama(): Promise<void> {
    setOllama(await window.cairn.checkOllama());
  }

  async function chooseVault(): Promise<void> {
    setError(null);
    const selected = await window.cairn.selectVault();
    if (!selected) return;
    setVaultPath(selected);
    setIndexStats(null);
    setHits([]);
    setSearchSubmitted(false);
    setAskResult(null);
    setSelectedSource(null);
  }

  async function indexVault(lexical: boolean): Promise<void> {
    if (!vaultPath) return;
    setBusy("index");
    setError(null);
    try {
      const stats = await window.cairn.indexVault({ lexical });
      setIndexStats(stats);
      setHits([]);
      setSearchSubmitted(false);
      setAskResult(null);
      setSelectedSource(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function searchVault(query: string): Promise<void> {
    if (!vaultPath) return;
    setBusy("search");
    setError(null);
    setSearchSubmitted(true);
    try {
      const results = await window.cairn.searchVault(query);
      setHits(results);
      setSelectedSource(results[0] ?? null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function askVault(question: string): Promise<void> {
    if (!vaultPath) return;
    setBusy("ask");
    setError(null);
    try {
      const result = await window.cairn.askVault(question);
      setAskResult(result);
      setSelectedSource((current) => result.sources[0] ?? current);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function openSelectedSource(hit: SearchHit): Promise<void> {
    if (!vaultPath) return;
    setError(null);
    try {
      await window.cairn.openSource(hit.file);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  // Stable identity so SourceViewer's load effect does not re-run every render.
  const readSource = useCallback((file: string) => window.cairn.readSource(file), []);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Cairn Desktop Alpha</p>
          <h1>Local vault search</h1>
        </div>
        <VaultPicker
          vaultPath={vaultPath}
          ollama={ollama}
          busy={busy !== null}
          onChooseVault={chooseVault}
          onRefreshOllama={refreshOllama}
        />
      </header>

      {error ? <div className="notice notice-error">{error}</div> : null}

      <section className="workspace-grid">
        <div className="left-rail">
          <IndexPanel
            busy={busy === "index"}
            disabled={!vaultPath}
            indexStats={indexStats}
            ollama={ollama}
            onIndex={indexVault}
          />
          <SearchPanel
            busy={busy === "search"}
            disabled={!canQuery}
            emptyMessage={
              !vaultPath
                ? "Choose a vault to search your local Markdown notes."
                : !indexStats
                  ? "Index this vault before searching it."
                  : "Search your indexed Markdown vault."
            }
            hits={hits}
            searchSubmitted={searchSubmitted}
            onSearch={searchVault}
            onSelectSource={setSelectedSource}
          />
        </div>

        <div className="center-rail">
          <AskPanel
            busy={busy === "ask"}
            disabled={!canQuery || !ollama.up}
            disabledMessage={
              !vaultPath
                ? "Choose a vault before asking Cairn."
                : !indexStats
                  ? "Index this vault before asking Cairn."
                  : !ollama.up
                    ? "Search works without AI. Ask requires local Ollama and a compatible model. No cloud calls will be made."
                    : "Ask is unavailable."
            }
            result={askResult}
            onAsk={askVault}
            onSelectSource={setSelectedSource}
          />
        </div>

        <SourceViewer
          source={selectedSource}
          disabled={!vaultPath}
          onOpenSource={openSelectedSource}
          onReadSource={readSource}
        />
      </section>
    </main>
  );
}
