import { useState } from "react";
import type { FormEvent } from "react";

type SearchHit = Awaited<ReturnType<typeof window.cairn.searchVault>>[number];

interface SearchPanelProps {
  busy: boolean;
  disabled: boolean;
  emptyMessage: string;
  hits: SearchHit[];
  searchSubmitted: boolean;
  onSearch(query: string): void;
  onSelectSource(hit: SearchHit): void;
}

export function SearchPanel({
  busy,
  disabled,
  emptyMessage,
  hits,
  searchSubmitted,
  onSearch,
  onSelectSource,
}: SearchPanelProps) {
  const [query, setQuery] = useState("");

  function submit(event: FormEvent): void {
    event.preventDefault();
    const trimmed = query.trim();
    if (trimmed) onSearch(trimmed);
  }

  return (
    <section className="panel search-panel">
      <div className="panel-heading">
        <div>
          <p className="label">Search</p>
          <h2>Cited chunks</h2>
        </div>
        <span className="status-pill">{hits.length} hits</span>
      </div>

      <form className="stack" onSubmit={submit}>
        <input
          type="search"
          value={query}
          placeholder="Search your notes"
          disabled={busy || disabled}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button type="submit" disabled={busy || disabled || !query.trim()}>
          {busy ? "Searching..." : "Search Vault"}
        </button>
      </form>

      <div className="result-list">
        {hits.length > 0 ? (
          hits.map((hit, index) => (
            <button
              type="button"
              className="result-row"
              key={`${hit.file}:${hit.line}:${index}`}
              onClick={() => onSelectSource(hit)}
            >
              <span className="result-title">{hit.file}</span>
              <span className="result-meta">
                line {hit.line}
                {hit.heading ? ` - ${hit.heading}` : ""} · {hit.arms}
              </span>
              <span className="result-snippet">{hit.snippet}</span>
            </button>
          ))
        ) : (
          <p className="muted">
            {searchSubmitted ? "No results found in this indexed vault." : emptyMessage}
          </p>
        )}
      </div>
    </section>
  );
}
