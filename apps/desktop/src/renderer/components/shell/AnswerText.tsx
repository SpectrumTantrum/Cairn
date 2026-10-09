import type { SearchHit } from "../../../shared/types.js";
import { splitInlineCites } from "../../agent-citations";
import { answerMarkdownRuns } from "../../answer-markdown";
import { CitationCard } from "./CitationCard";

/** Prose with `**bold**` and `*italic*` rendered, and the markers removed. */
export function AnswerMarkdown({ text }: { text: string }) {
  return answerMarkdownRuns(text).map((run, index) => {
    if (run.kind === "strong") return <strong key={index}>{run.text}</strong>;
    if (run.kind === "em") return <em key={index}>{run.text}</em>;
    return <span key={index}>{run.text}</span>;
  });
}

/**
 * Answer prose with inline `[path:line]` markers rendered as citation chips.
 * Markers that don't match a cited source are omitted by `splitInlineCites`.
 * Emphasis is applied only to the prose between those chips.
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
          <AnswerMarkdown key={i} text={segment.text} />
        ) : (
          <CitationCard key={i} hit={segment.hit} variant="pill" onOpen={onCite} />
        ),
      )}
    </div>
  );
}
