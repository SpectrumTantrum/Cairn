import { AlertTriangle, Sparkles } from "lucide-react";
import type { ChatSendResult, SearchHit } from "../../../shared/types.js";
import { Composer } from "./Composer";

export type ChatTurn =
  | { role: "user"; text: string }
  | { role: "assistant"; streaming: true; text: string }
  | { role: "assistant"; streaming: false; result: ChatSendResult }
  | { role: "error"; text: string };

interface ChatTabProps {
  thread: ChatTurn[];
  busy: boolean;
  input: string;
  composerDisabled: boolean;
  composerReason: string | null;
  ollamaUp: boolean;
  models: string[];
  selectedModel: string | null;
  scopeCount: number;
  onInputChange(value: string): void;
  onSelectModel(model: string): void;
  onSubmit(): void;
  onClearScope(): void;
  onCite(source: SearchHit): void;
}

export function ChatTab(props: ChatTabProps) {
  const { thread, busy, onCite } = props;
  return (
    <>
      <div className="chat-thread">
        {thread.length === 0 && !busy ? (
          <p className="chat-empty">
            Ask a question grounded in this vault. Every answer cites the notes it used — click a
            citation to open the source.
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
          if (turn.streaming) {
            return <StreamingTurn key={i} text={turn.text} />;
          }
          return <AssistantTurn key={i} result={turn.result} onCite={onCite} />;
        })}
      </div>
      <Composer
        value={props.input}
        disabled={props.composerDisabled}
        disabledReason={props.composerReason}
        ollamaUp={props.ollamaUp}
        models={props.models}
        selectedModel={props.selectedModel}
        busy={busy}
        scopeCount={props.scopeCount}
        onChange={props.onInputChange}
        onSelectModel={props.onSelectModel}
        onSubmit={props.onSubmit}
        onClearScope={props.onClearScope}
      />
    </>
  );
}

/** The in-flight assistant turn: shows the thinking pulse until the first token lands. */
function StreamingTurn({ text }: { text: string }) {
  return (
    <div className="chat-assistant">
      <span className="chat-avatar">
        <Sparkles size={14} />
      </span>
      <div className="chat-assistant-body">
        {text.length === 0 ? (
          <span className="chat-thinking">
            <span className="dot-pulse" /> Grounding in your notes…
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
      <span className="chat-avatar">
        <Sparkles size={14} />
      </span>
      <div className="chat-assistant-body">
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

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}
