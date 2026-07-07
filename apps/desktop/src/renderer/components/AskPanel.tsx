import { useState } from "react";
import type { FormEvent } from "react";
import type { AskResult, SearchHit } from "../../shared/types.js";

interface AskPanelProps {
  busy: boolean;
  disabled: boolean;
  disabledMessage: string;
  result: AskResult | null;
  onAsk(question: string): void;
  onSelectSource(hit: SearchHit): void;
}

export function AskPanel({
  busy,
  disabled,
  disabledMessage,
  result,
  onAsk,
  onSelectSource,
}: AskPanelProps) {
  const [question, setQuestion] = useState("");

  function submit(event: FormEvent): void {
    event.preventDefault();
    const trimmed = question.trim();
    if (trimmed) onAsk(trimmed);
  }

  return (
    <section className="panel ask-panel">
      <div className="panel-heading">
        <div>
          <p className="label">Ask</p>
          <h2>Grounded answer</h2>
        </div>
        <span className={`status-pill ${result?.covered ? "ready" : ""}`}>
          {result ? (result.covered ? result.mode : "Unsupported") : "Idle"}
        </span>
      </div>

      <form className="stack" onSubmit={submit}>
        <textarea
          rows={5}
          value={question}
          placeholder="Ask a question answered by this vault"
          disabled={busy || disabled}
          onChange={(event) => setQuestion(event.target.value)}
        />
        <button type="submit" disabled={busy || disabled || !question.trim()}>
          {busy ? "Asking..." : "Ask Vault"}
        </button>
      </form>

      {disabled ? <p className="muted">{disabledMessage}</p> : null}

      {result ? (
        <article className={`answer-card ${result.covered ? "" : "unsupported"}`}>
          <p>{result.answer}</p>
          {!result.covered && result.reason ? (
            <p className="answer-reason">{result.reason}</p>
          ) : null}
          {result.sources.length > 0 ? (
            <div className="source-list">
              {result.sources.map((source, index) => (
                <button
                  type="button"
                  key={`${source.file}:${source.line}:${index}`}
                  onClick={() => onSelectSource(source)}
                >
                  [{index + 1}] {source.file}:{source.line}
                </button>
              ))}
            </div>
          ) : null}
        </article>
      ) : null}
    </section>
  );
}
