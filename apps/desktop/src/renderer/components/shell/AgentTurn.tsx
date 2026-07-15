import { Check, Sparkles, Undo2, X } from "lucide-react";
import type { DiffLine, EditProposal, SearchHit } from "../../../shared/types.js";
import { CitationCard } from "./CitationCard";

/** A proposal plus its live approval status in the UI. */
export type ProposalStatus = "pending" | "applied" | "rejected" | "skipped";
export interface UiProposal extends EditProposal {
  status: ProposalStatus;
}

/** One Agent turn: the grounded summary, per-edit diff cards, and a run footer. */
export interface AgentThreadTurn {
  role: "agent";
  runId: string;
  answer: string;
  proposals: UiProposal[];
  sources: SearchHit[];
  stopReason: string;
  steps: number;
  reverted?: boolean;
}

interface AgentTurnProps {
  turn: AgentThreadTurn;
  onApply(runId: string, proposalId: string): void;
  onReject(runId: string, proposalId: string): void;
  onRevert(runId: string): void;
  onCite(source: SearchHit): void;
}

export function AgentTurn({ turn, onApply, onReject, onRevert, onCite }: AgentTurnProps) {
  const appliedCount = turn.proposals.filter((p) => p.status === "applied").length;
  const rejectedCount = turn.proposals.filter((p) => p.status === "rejected").length;
  const skippedCount = turn.proposals.filter((p) => p.status === "skipped").length;

  return (
    <div className="chat-assistant">
      <span className="chat-avatar">
        <Sparkles size={14} />
      </span>
      <div className="chat-assistant-body">
        {turn.answer ? <div className="assistant-text">{turn.answer}</div> : null}

        {turn.stopReason === "no-tool-support" ? (
          <div className="assistant-reason">
            This model can't call tools. Pull a tool-capable local model to use Agent mode.
          </div>
        ) : null}

        {turn.proposals.length === 0 && turn.stopReason !== "no-tool-support" ? (
          <div className="assistant-reason">The agent proposed no edits.</div>
        ) : null}

        {turn.proposals.map((p) => (
          <DiffCard
            key={p.id}
            proposal={p}
            reverted={!!turn.reverted}
            onApply={() => onApply(turn.runId, p.id)}
            onReject={() => onReject(turn.runId, p.id)}
          />
        ))}

        {turn.proposals.length > 0 ? (
          <div className="agent-run-footer">
            <span className="agent-run-summary">
              {appliedCount} applied · {rejectedCount} rejected
              {skippedCount ? ` · ${skippedCount} skipped` : ""}
            </span>
            {appliedCount > 0 && !turn.reverted ? (
              <button
                type="button"
                className="chip"
                title="Revert every applied edit from this run — restores the vault byte-identically (ADR-0008)"
                onClick={() => onRevert(turn.runId)}
              >
                <Undo2 size={13} /> Revert run
              </button>
            ) : null}
            {turn.reverted ? <span className="agent-run-reverted">Run reverted</span> : null}
          </div>
        ) : null}

        {turn.sources.length > 0 ? (
          <div className="citation-row">
            {turn.sources.map((s, i) => (
              <CitationCard
                key={`${s.file}:${s.line}:${i}`}
                hit={s}
                variant="pill"
                index={i + 1}
                onOpen={onCite}
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** A bordered agent-edit card: header, Accept/Reject, red/green diff body (ADR-0008 wireframe). */
function DiffCard({
  proposal,
  reverted,
  onApply,
  onReject,
}: {
  proposal: UiProposal;
  reverted: boolean;
  onApply(): void;
  onReject(): void;
}) {
  const { preview, status } = proposal;
  const decided = status !== "pending";
  return (
    <div className={`diff-card status-${status}`}>
      <div className="diff-card-head">
        <span className="diff-card-title">
          <Sparkles size={12} />
          {proposal.op === "add" ? "New note" : "Agent edit"} · {proposal.path}
        </span>
        <span className="diff-card-stats">
          <span className="diff-added">+{preview.added}</span>{" "}
          <span className="diff-removed">−{preview.removed}</span>
        </span>
      </div>

      <pre className="diff-body">
        {preview.lines.map((line, i) => (
          <DiffLineRow key={i} line={line} />
        ))}
      </pre>

      <div className="diff-card-actions">
        {status === "pending" ? (
          <>
            <button type="button" className="diff-accept" onClick={onApply}>
              <Check size={13} /> Accept
            </button>
            <button type="button" className="diff-reject" onClick={onReject}>
              <X size={13} /> Reject
            </button>
          </>
        ) : (
          <span className={`diff-status-label ${status}`}>
            {status === "applied" && !reverted ? "Applied" : null}
            {status === "applied" && reverted ? "Reverted" : null}
            {status === "rejected" ? "Rejected" : null}
            {status === "skipped" ? "Skipped — file changed on disk" : null}
          </span>
        )}
        {decided && status === "skipped" ? null : null}
      </div>
    </div>
  );
}

function DiffLineRow({ line }: { line: DiffLine }) {
  const prefix = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
  return (
    <span className={`diff-line ${line.type}`}>
      {prefix} {line.text || " "}
      {"\n"}
    </span>
  );
}
