import { useState } from "react";
import { AlertTriangle, ChevronDown, Cloud, HardDrive, Sparkles } from "lucide-react";
import type {
  ChatSendResult,
  EscalateTarget,
  ProviderMeta,
  SearchHit,
} from "../../../shared/types.js";
import { Composer } from "./Composer";
import type { AgentMode } from "./Composer";
import { AgentTurn } from "./AgentTurn";
import type { AgentThreadTurn } from "./AgentTurn";

export type ChatTurn =
  | { role: "user"; text: string }
  | { role: "assistant"; streaming: true; text: string }
  | { role: "assistant"; streaming: false; result: ChatSendResult }
  | AgentThreadTurn
  | { role: "error"; text: string };

interface ChatTabProps {
  thread: ChatTurn[];
  busy: boolean;
  input: string;
  mode: AgentMode;
  composerDisabled: boolean;
  composerReason: string | null;
  ollamaUp: boolean;
  models: string[];
  selectedModel: string | null;
  scopeCount: number;
  providers: ProviderMeta[];
  escalateTarget: EscalateTarget | null;
  onInputChange(value: string): void;
  onSelectMode(mode: AgentMode): void;
  onSelectModel(model: string): void;
  onSelectEscalation(target: EscalateTarget | null): void;
  onOpenSettings(): void;
  onSubmit(): void;
  onClearScope(): void;
  onCite(source: SearchHit): void;
  onAgentApply(runId: string, proposalId: string): void;
  onAgentReject(runId: string, proposalId: string): void;
  onAgentRevert(runId: string): void;
}

export function ChatTab(props: ChatTabProps) {
  const { thread, busy, mode, onCite } = props;
  const lastRole = thread.length ? thread[thread.length - 1].role : null;
  // For the agent (non-streaming) path there is no streaming placeholder — show a
  // working pulse while a run is in flight (the last turn is still the user's goal).
  const showWorking = busy && lastRole === "user";
  return (
    <>
      <div className="chat-thread">
        {thread.length === 0 && !busy ? (
          <p className="chat-empty">
            {mode === "agent"
              ? "Give the agent a task. It proposes edits as diffs you approve one at a time — nothing is written until you accept it."
              : "Ask a question grounded in this vault. Every answer cites the notes it used — click a citation to open the source."}
          </p>
        ) : null}
        {thread.map((turn, i) => {
          if (turn.role === "user") {
            return (
              <div className="chat-user" key={i}>
                {turn.text}
              </div>
            );
          }
          if (turn.role === "error") {
            return <ErrorTurn key={i} text={turn.text} />;
          }
          if (turn.role === "agent") {
            return (
              <AgentTurn
                key={i}
                turn={turn}
                onApply={props.onAgentApply}
                onReject={props.onAgentReject}
                onRevert={props.onAgentRevert}
                onCite={onCite}
              />
            );
          }
          if (turn.streaming) {
            return <StreamingTurn key={i} text={turn.text} />;
          }
          return <AssistantTurn key={i} result={turn.result} onCite={onCite} />;
        })}
        {showWorking ? (
          <StreamingTurn text="" label={mode === "agent" ? "Proposing edits…" : "Grounding in your notes…"} />
        ) : null}
      </div>
      <Composer
        value={props.input}
        disabled={props.composerDisabled}
        disabledReason={props.composerReason}
        ollamaUp={props.ollamaUp}
        models={props.models}
        selectedModel={props.selectedModel}
        busy={busy}
        mode={props.mode}
        scopeCount={props.scopeCount}
        providers={props.providers}
        escalateTarget={props.escalateTarget}
        onChange={props.onInputChange}
        onSelectMode={props.onSelectMode}
        onSelectModel={props.onSelectModel}
        onSelectEscalation={props.onSelectEscalation}
        onOpenSettings={props.onOpenSettings}
        onSubmit={props.onSubmit}
        onClearScope={props.onClearScope}
      />
    </>
  );
}

/** The in-flight assistant turn: shows the thinking pulse until the first token lands. */
function StreamingTurn({ text, label }: { text: string; label?: string }) {
  return (
    <div className="chat-assistant">
      <span className="chat-avatar">
        <Sparkles size={14} />
      </span>
      <div className="chat-assistant-body">
        {text.length === 0 ? (
          <span className="chat-thinking">
            <span className="dot-pulse" /> {label ?? "Grounding in your notes…"}
          </span>
        ) : (
          <div className="assistant-text streaming">{text}</div>
        )}
      </div>
    </div>
  );
}

function ErrorTurn({ text }: { text: string }) {
  return (
    <div className="chat-assistant">
      <span className="chat-avatar error">
        <AlertTriangle size={14} />
      </span>
      <div className="chat-assistant-body">
        <div className="assistant-text unsupported">{text}</div>
      </div>
    </div>
  );
}

function AssistantTurn({ result, onCite }: { result: ChatSendResult; onCite(s: SearchHit): void }) {
  return (
    <div className="chat-assistant">
      <span className={`chat-avatar${result.escalated ? " cloud" : ""}`}>
        {result.escalated ? <Cloud size={14} /> : <Sparkles size={14} />}
      </span>
      <div className="chat-assistant-body">
        {result.escalated ? (
          <EscalatedMeta result={result} />
        ) : result.covered && result.model ? (
          <LocalMeta model={result.model} />
        ) : null}
        <div className={`assistant-text${result.covered ? "" : " unsupported"}`}>
          {result.answer}
        </div>
        {!result.covered && result.reason ? (
          <div className="assistant-reason">{result.reason}</div>
        ) : null}
        {result.sources.length > 0 ? (
          <div className="citation-row">
            {result.sources.map((s, i) => (
              <button
                type="button"
                className="citation-pill"
                key={`${s.file}:${s.line}:${i}`}
                title={`Open ${s.file} at line ${s.line}`}
                onClick={() => onCite(s)}
              >
                <span className="citation-index">{i + 1}</span>
                <span className="cite-loc">
                  {basename(s.file)}:{s.line}
                  {s.heading ? ` › ${s.heading}` : ""}
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Quiet provenance badge on a LOCAL (Ollama-grounded) answer turn (issue #14). Local is the
 * default, not an event — so this is deliberately muted, far lighter than EscalatedMeta: just
 * the model name behind a hard-drive glyph, no usage/cost/disclosure (none apply locally).
 */
function LocalMeta({ model }: { model: string }) {
  return (
    <div className="local-meta">
      <span className="local-badge" title="Answered locally by Ollama — no cloud calls">
        <HardDrive size={11} /> {model}
      </span>
    </div>
  );
}

/**
 * Cloud-escalation header on an answer (ADR-0002): a ☁ badge + model, the real token
 * usage / cost the API returned (never fabricated), and a "what was sent" disclosure so
 * the exact system prompt + retrieved excerpts + question are always inspectable.
 */
function EscalatedMeta({ result }: { result: ChatSendResult }) {
  const [openSent, setOpenSent] = useState(false);
  const u = result.usage;
  const usageBits: string[] = [];
  if (u?.promptTokens !== undefined) usageBits.push(`${u.promptTokens} in`);
  if (u?.completionTokens !== undefined) usageBits.push(`${u.completionTokens} out`);
  if (u?.totalTokens !== undefined && usageBits.length === 0) usageBits.push(`${u.totalTokens} tokens`);
  const cost = u?.costUsd !== undefined ? `$${u.costUsd.toFixed(u.costUsd < 0.01 ? 5 : 4)}` : null;

  return (
    <div className="escalated-meta">
      <div className="escalated-line">
        <span className="cloud-badge" title="Answered by a cloud model (BYOK escalation)">
          <Cloud size={11} /> {result.model ?? "cloud"}
        </span>
        {usageBits.length > 0 ? <span className="usage-line">{usageBits.join(" · ")}</span> : null}
        {cost ? <span className="cost-line">{cost}</span> : null}
        {usageBits.length === 0 && !cost ? (
          <span className="usage-line muted">usage not reported</span>
        ) : null}
      </div>
      {result.sent ? (
        <>
          <button type="button" className="sent-toggle" onClick={() => setOpenSent((v) => !v)}>
            <ChevronDown size={11} className={openSent ? "rot" : ""} /> what was sent
          </button>
          {openSent ? (
            <div className="sent-disclosure">
              <div className="sent-section">
                <span className="sent-label">System prompt</span>
                <pre>{result.sent.system}</pre>
              </div>
              <div className="sent-section">
                <span className="sent-label">Retrieved excerpts</span>
                <pre>{result.sent.sourcesBlock}</pre>
              </div>
              <div className="sent-section">
                <span className="sent-label">Question</span>
                <pre>{result.sent.question}</pre>
              </div>
              <p className="sent-foot">
                Plus {result.sent.historyTurns} prior conversation turn
                {result.sent.historyTurns === 1 ? "" : "s"} from this thread.
              </p>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}
