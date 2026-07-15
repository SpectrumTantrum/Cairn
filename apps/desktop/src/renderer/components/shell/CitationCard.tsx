import type { SearchHit } from "../../../shared/types.js";
import { basename, citationTitle } from "../../cite-format";

interface CitationCardProps {
  hit: SearchHit;
  /**
   * `full` — vertical card (location line + snippet) used by vault-search results and
   * Sources-tab rows. `pill` — compact inline chip (location only) used by chat citations.
   */
  variant: "pill" | "full";
  /** 1-based badge number shown before the location (chat citation pills). */
  index?: number;
  /** Force snippet visibility. Defaults: `full` → shown, `pill` → hidden. */
  showSnippet?: boolean;
  onOpen(hit: SearchHit): void;
}

/**
 * One citation card reused across the three surfaces that reference a source chunk
 * (issue #15). Click-through routing stays the caller's concern: `onOpen` wires to the
 * surface's existing handler (`openSearchResult` / `openCitation`) unchanged.
 */
export function CitationCard({ hit, variant, index, showSnippet, onOpen }: CitationCardProps) {
  const withSnippet = showSnippet ?? variant === "full";
  return (
    <button
      type="button"
      className={`citation-card citation-card-${variant}`}
      title={citationTitle(hit.file, hit.line)}
      onClick={() => onOpen(hit)}
    >
      {index !== undefined ? <span className="citation-index">{index}</span> : null}
      <span className="citation-loc">
        {basename(hit.file)}
        <span className="citation-line">:{hit.line}</span>
        {hit.heading ? <span className="citation-heading"> › {hit.heading}</span> : null}
      </span>
      {withSnippet && hit.snippet ? <span className="citation-snippet">{hit.snippet}</span> : null}
    </button>
  );
}
