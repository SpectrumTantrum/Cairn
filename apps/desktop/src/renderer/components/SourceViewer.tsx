import { useEffect, useRef, useState } from "react";
import type { SearchHit } from "../../shared/types.js";

interface SourceViewerProps {
  source: SearchHit | null;
  disabled: boolean;
  onOpenSource(hit: SearchHit): void;
  onReadSource(file: string): Promise<string>;
}

/** Inclusive 1-based line span the cited chunk covers, clamped to the file length. */
function citedSpan(source: SearchHit, lineCount: number): { start: number; end: number } | null {
  if (source.line < 1 || lineCount < 1) return null;
  const start = Math.min(source.line, lineCount);
  const chunkLines = source.text ? source.text.split("\n").length : 1;
  const end = Math.min(start + Math.max(1, chunkLines) - 1, lineCount);
  return { start, end };
}

export function SourceViewer({
  source,
  disabled,
  onOpenSource,
  onReadSource,
}: SourceViewerProps) {
  const [lines, setLines] = useState<string[] | null>(null);
  const [loadedFile, setLoadedFile] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const citedRef = useRef<HTMLDivElement | null>(null);

  const file = source?.file ?? null;
  const line = source?.line ?? null;

  // Load the source file whenever the cited file changes.
  useEffect(() => {
    let cancelled = false;
    if (!file) {
      setLines(null);
      setLoadedFile(null);
      setReadError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setReadError(null);
    onReadSource(file)
      .then((content) => {
        if (cancelled) return;
        setLines(content.split("\n"));
        setLoadedFile(file);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLines(null);
        setLoadedFile(null);
        setReadError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [file, onReadSource]);

  // Scroll the cited line into view once the matching file is loaded (and on line change).
  useEffect(() => {
    if (loadedFile && loadedFile === file) {
      citedRef.current?.scrollIntoView({ block: "center" });
    }
  }, [loadedFile, file, line]);

  const span = source && lines && loadedFile === source.file ? citedSpan(source, lines.length) : null;

  return (
    <aside className="panel source-viewer">
      <div className="panel-heading">
        <div>
          <p className="label">Source</p>
          <h2>Cited source</h2>
        </div>
        {source ? (
          <button
            type="button"
            className="secondary-button"
            disabled={disabled}
            onClick={() => onOpenSource(source)}
          >
            Open externally
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

          {loading ? (
            <p className="muted source-hint">Loading source…</p>
          ) : readError ? (
            <p className="muted source-hint">{readError}</p>
          ) : lines && loadedFile === source.file ? (
            <div className="source-file" role="region" aria-label={`${source.file} at line ${source.line}`}>
              {lines.map((text, i) => {
                const lineNo = i + 1;
                const cited = span !== null && lineNo >= span.start && lineNo <= span.end;
                return (
                  <div
                    key={lineNo}
                    ref={span !== null && lineNo === span.start ? citedRef : undefined}
                    className={`source-line${cited ? " cited" : ""}`}
                  >
                    <span className="source-line-no">{lineNo}</span>
                    <span className="source-line-text">{text === "" ? " " : text}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="muted source-hint">This source could not be displayed.</p>
          )}
        </>
      ) : (
        <p className="muted">Select a search hit or answer source to jump to the cited line.</p>
      )}
    </aside>
  );
}
