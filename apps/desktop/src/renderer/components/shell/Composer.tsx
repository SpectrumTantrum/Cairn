import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { ArrowUp, Check, ChevronDown, Cloud, Filter, X } from "lucide-react";

interface ComposerProps {
  value: string;
  disabled: boolean;
  /** Explains why the composer is inert (no vault / not indexed / Ollama offline). */
  disabledReason: string | null;
  ollamaUp: boolean;
  models: string[];
  selectedModel: string | null;
  busy: boolean;
  /** Number of sources the next question is scoped to (0 = whole index). */
  scopeCount: number;
  onChange(value: string): void;
  onSelectModel(model: string): void;
  onSubmit(): void;
  onClearScope(): void;
}

export function Composer({
  value,
  disabled,
  disabledReason,
  ollamaUp,
  models,
  selectedModel,
  busy,
  scopeCount,
  onChange,
  onSelectModel,
  onSubmit,
  onClearScope,
}: ComposerProps) {
  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!disabled && !busy && value.trim()) onSubmit();
    }
  }

  const canSend = !disabled && !busy && value.trim().length > 0;

  return (
    <div className="composer">
      {scopeCount > 0 ? (
        <div className="composer-scope">
          <Filter size={12} />
          <span>
            scoped to {scopeCount} source{scopeCount === 1 ? "" : "s"}
          </span>
          <button type="button" className="scope-clear" title="Clear scope — ask across the whole vault" onClick={onClearScope}>
            <X size={11} />
          </button>
        </div>
      ) : null}
      <div className="composer-box">
        <textarea
          className="composer-input"
          rows={2}
          value={value}
          placeholder="Ask, or / for a preset, @ for a node…"
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="composer-controls">
          <ModeChip />
          <ModelChip
            models={models}
            selectedModel={selectedModel}
            ollamaUp={ollamaUp}
            onSelectModel={onSelectModel}
          />
          <button
            type="button"
            className="chip dashed"
            aria-disabled="true"
            title="Coming in v1 — cloud escalation must surface cost before any outbound call (ADR-0002)"
          >
            <Cloud size={13} /> escalate
          </button>
          <span className="spacer" />
          <button
            type="button"
            className="send-btn"
            title="Send (Enter)"
            disabled={!canSend}
            onClick={onSubmit}
          >
            <ArrowUp size={16} />
          </button>
        </div>
      </div>
      {disabledReason ? (
        <p className={`composer-note${!ollamaUp ? " warn" : ""}`}>{disabledReason}</p>
      ) : null}
    </div>
  );
}

/** Trust-mode picker. Ask is the only live mode; Agent is a stub (needs write-safety core). */
function ModeChip() {
  const [open, setOpen] = useState(false);
  const ref = useCloseOnOutside(() => setOpen(false));
  return (
    <span className="menu-wrap" ref={ref}>
      <button type="button" className="chip accent" onClick={() => setOpen((v) => !v)}>
        Ask <ChevronDown size={13} />
      </button>
      {open ? (
        <div className="menu">
          <button type="button" className="menu-item selected">
            <Check size={13} /> Ask
            <span className="menu-sub">read-only · grounded</span>
          </button>
          <button
            type="button"
            className="menu-item"
            disabled
            title="Coming in v1 — needs the agent write-safety core (ADR-0008)"
          >
            Agent
            <span className="menu-sub">write · tool loop</span>
          </button>
        </div>
      ) : null}
    </span>
  );
}

function ModelChip({
  models,
  selectedModel,
  ollamaUp,
  onSelectModel,
}: {
  models: string[];
  selectedModel: string | null;
  ollamaUp: boolean;
  onSelectModel(model: string): void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useCloseOnOutside(() => setOpen(false));
  const label = selectedModel ?? (ollamaUp ? "No model" : "Ollama offline");
  const disabled = !ollamaUp || models.length === 0;
  return (
    <span className="menu-wrap" ref={ref}>
      <button
        type="button"
        className="chip"
        aria-disabled={disabled ? "true" : undefined}
        title={disabled ? "Start Ollama and pull a chat model to choose one" : "Chat model for answers"}
        onClick={() => !disabled && setOpen((v) => !v)}
      >
        {truncate(label)} <ChevronDown size={13} />
      </button>
      {open && !disabled ? (
        <div className="menu">
          {models.map((m) => (
            <button
              type="button"
              key={m}
              className={`menu-item${m === selectedModel ? " selected" : ""}`}
              onClick={() => {
                onSelectModel(m);
                setOpen(false);
              }}
            >
              {m === selectedModel ? <Check size={13} /> : <span style={{ width: 13 }} />}
              {m}
            </button>
          ))}
        </div>
      ) : null}
    </span>
  );
}

function truncate(s: string): string {
  return s.length > 22 ? `${s.slice(0, 21)}…` : s;
}

function useCloseOnOutside(onClose: () => void) {
  const ref = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    function handle(e: MouseEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [onClose]);
  return ref;
}
