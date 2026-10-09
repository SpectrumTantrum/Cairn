import type { SearchHit } from "../../../shared/types.js";
import { citationLandingLine } from "../../agent-citations";
import { basename, citationLineLabel, citationTitle, isPdfPath, pdfChipLabel, pdfOpenTitle } from "../../cite-format";

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
  const pdfPage = isPdfPath(hit.file) ? (hit.page ?? 0) : 0;
  // Label and tooltip use the heading line the click opens. hit.line can be a
  // later fact line; the heading on the chip stays the click target.
  // A PDF chip names the page (`report.pdf p.3`) and does not use a line or heading.
  const landing = pdfPage > 0 ? hit.line : citationLandingLine(hit);
  const title = pdfPage > 0 ? pdfOpenTitle(hit.file, pdfPage) : citationTitle(hit.file, landing, hit.heading);
  return (
    <button
      type="button"
      className={`citation-card citation-card-${variant}`}
      title={title}
      onClick={() => onOpen(hit)}
    >
      {index !== undefined ? <span className="citation-index">{index}</span> : null}
      <span className="citation-loc">
        {pdfPage > 0 ? (
          pdfChipLabel(hit.file, pdfPage)
        ) : (
          <>
            {basename(hit.file)}
            <span className="citation-line">:{citationLineLabel(landing)}</span>
            {hit.heading ? <span className="citation-heading"> › {hit.heading}</span> : null}
          </>
        )}
      </span>
      {withSnippet && hit.snippet ? <span className="citation-snippet">{hit.snippet}</span> : null}
    </button>
  );
}
