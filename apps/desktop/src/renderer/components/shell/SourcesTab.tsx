import { Check } from "lucide-react";
import type { SearchHit } from "../../../shared/types.js";
import { CitationCard } from "./CitationCard";
import { typeChip } from "../../cite-format";

interface SourcesTabProps {
  sources: SearchHit[];
  /** Vault-relative file paths currently unchecked (excluded from the next question's retrieval). */
  excluded: Set<string>;
  onToggle(file: string): void;
  onOpen(source: SearchHit): void;
}

/**
 * NotebookLM-style source list. Checkboxes are live: they control the NEXT question's
 * retrieval scope (not the current answer). All checked by default; unchecking a source
 * excludes it via `SearchOpts.scope`. If nothing is unchecked, retrieval spans the whole
 * index. See the composer's "scoped to N sources" indicator when a scope is active.
 * Unchecking every source also falls back to the whole index (an empty include-list is
 * not a "match nothing" scope) — the header says "whole vault" rather than "0 scoping
 * next question" to keep that honest.
 */
export function SourcesTab({ sources, excluded, onToggle, onOpen }: SourcesTabProps) {
  const unique = dedupe(sources);
  const checkedCount = unique.filter((s) => !excluded.has(s.file)).length;
  return (
    <div className="sources-body">
      <p className="sources-header">
        {unique.length} in chat
        {unique.length > 0 && checkedCount !== unique.length
          ? checkedCount === 0
            ? " · whole vault"
            : ` · ${checkedCount} scoping next question`
          : ""}
      </p>
      {sources.length === 0 ? (
        <p className="muted">Ask a question to see the notes it was grounded in.</p>
      ) : (
        unique.map((s, i) => {
          const checked = !excluded.has(s.file);
          return (
            <div className="source-check-row" key={`${s.file}:${i}`}>
              <button
                type="button"
                className={`source-check-box${checked ? " checked" : ""}`}
                role="checkbox"
                aria-checked={checked}
                title={checked ? "Uncheck to exclude from the next question" : "Check to include in the next question"}
                onClick={() => onToggle(s.file)}
              >
                {checked ? <Check size={12} /> : null}
              </button>
              <CitationCard hit={s} variant="full" onOpen={onOpen} />
              <span className="type-chip">{typeChip(s.file)}</span>
            </div>
          );
        })
      )}
    </div>
  );
}

function dedupe(sources: SearchHit[]): SearchHit[] {
  const seen = new Set<string>();
  const out: SearchHit[] = [];
  for (const s of sources) {
    if (seen.has(s.file)) continue;
    seen.add(s.file);
    out.push(s);
  }
  return out;
}
