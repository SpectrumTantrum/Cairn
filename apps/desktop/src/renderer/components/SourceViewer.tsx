type SearchHit = Awaited<ReturnType<typeof window.cairn.searchVault>>[number];

interface SourceViewerProps {
  source: SearchHit | null;
  disabled: boolean;
  onOpenSource(hit: SearchHit): void;
}

export function SourceViewer({
  source,
  disabled,
  onOpenSource,
}: SourceViewerProps) {
  return (
    <aside className="panel source-viewer">
      <div className="panel-heading">
        <div>
          <p className="label">Source</p>
          <h2>Jump target</h2>
        </div>
        {source ? (
          <button
            type="button"
            className="secondary-button"
            disabled={disabled}
            onClick={() => onOpenSource(source)}
          >
            Open
          </button>
        ) : null}
      </div>

      {source ? (
        <>
          <div className="source-meta">
            <strong>{source.file}</strong>
            <span>line {source.line}</span>
            {source.heading ? <span>{source.heading}</span> : null}
          </div>
          <pre>{source.text}</pre>
        </>
      ) : (
        <p className="muted">Select a search hit or answer source to inspect the cited chunk.</p>
      )}
    </aside>
  );
}
