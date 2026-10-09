import type { SearchHit } from "../../../shared/types.js";
import { splitInlineCites } from "../../agent-citations";
import { CitationCard } from "./CitationCard";

/**
 * Answer prose with inline `[path:line]` markers rendered as citation chips.
 * Markers that don't match a cited source are omitted by `splitInlineCites`.
 */
export function AnswerText({
  answer,
  sources,
  className,
  onCite,
}: {
  answer: string;
  sources: readonly SearchHit[];
  className?: string;
  onCite(hit: SearchHit): void;
}) {
  const segments = splitInlineCites(answer, sources);
  return (
    <div className={className}>
      {segments.map((segment, i) =>
        segment.kind === "text" ? (
          <span key={i}>{segment.text}</span>
        ) : (
          <CitationCard key={i} hit={segment.hit} variant="pill" onOpen={onCite} />
        ),
      )}
    </div>
  );
}
