import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { ArrowUp, Check, ChevronDown, Cloud, Filter, HardDrive, Settings, X } from "lucide-react";
import type { EscalateTarget, ProviderMeta } from "../../../shared/types.js";

/** Top-level trust mode (ADR-0008). Ask is read-only; Agent runs the write tool loop. */
export type AgentMode = "ask" | "agent";

interface ComposerProps {
  value: string;
  disabled: boolean;
  /** Explains why the composer is inert (no vault / not indexed / Ollama offline). */
  disabledReason: string | null;
  ollamaUp: boolean;
  models: string[];
  selectedModel: string | null;
  busy: boolean;
  mode: AgentMode;
  /** Number of sources the next question is scoped to (0 = whole index). */
  scopeCount: number;
  /** Configured BYOK cloud providers (metadata only). */
  providers: ProviderMeta[];
  /** Armed escalation target, or null when the next turn stays local. */
  escalateTarget: EscalateTarget | null;
  onChange(value: string): void;
  onSelectMode(mode: AgentMode): void;
  onSelectModel(model: string): void;
  onSelectEscalation(target: EscalateTarget | null): void;
  onOpenSettings(): void;
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
  mode,
  scopeCount,
  providers,
  escalateTarget,
  onChange,
  onSelectMode,
  onSelectModel,
  onSelectEscalation,
  onOpenSettings,
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
          placeholder={mode === "agent" ? "Describe an edit — the agent proposes diffs you approve…" : "Ask, or / for a preset, @ for a node…"}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="composer-controls">
          <ModeChip mode={mode} onSelectMode={onSelectMode} />
          <ModelChip
            models={models}
            selectedModel={selectedModel}
            ollamaUp={ollamaUp}
            onSelectModel={onSelectModel}
          />
          <EscalateChip
            providers={providers}
            escalateTarget={escalateTarget}
            onSelectEscalation={onSelectEscalation}
            onOpenSettings={onOpenSettings}
          />
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

/**
 * Trust-mode picker (ADR-0008). Ask = read-only grounded Q&A; Agent = the write
 * tool-loop, where every proposed edit is a diff you approve before it touches disk.
 */
function ModeChip({ mode, onSelectMode }: { mode: AgentMode; onSelectMode(mode: AgentMode): void }) {
  const [open, setOpen] = useState(false);
  const ref = useCloseOnOutside(() => setOpen(false));
  return (
    <span className="menu-wrap" ref={ref}>
      <button type="button" className="chip accent" onClick={() => setOpen((v) => !v)}>
        {mode === "agent" ? "Agent" : "Ask"} <ChevronDown size={13} />
      </button>
      {open ? (
        <div className="menu">
          <button
            type="button"
            className={`menu-item${mode === "ask" ? " selected" : ""}`}
            onClick={() => {
              onSelectMode("ask");
              setOpen(false);
            }}
          >
            {mode === "ask" ? <Check size={13} /> : <span style={{ width: 13 }} />} Ask
            <span className="menu-sub">read-only · grounded</span>
          </button>
          <button
            type="button"
            className={`menu-item${mode === "agent" ? " selected" : ""}`}
            title="Every edit is shown as a diff and applied only when you approve it (ADR-0008)"
            onClick={() => {
              onSelectMode("agent");
              setOpen(false);
            }}
          >
            {mode === "agent" ? <Check size={13} /> : <span style={{ width: 13 }} />} Agent
            <span className="menu-sub">write · approve each diff</span>
          </button>
        </div>
      ) : null}
    </span>
  );
}

/**
 * Cloud escalation picker (ADR-0002). Disabled with a BYOK tooltip until ≥1 provider
 * is configured (click routes to Settings). When armed, the chip shows ☁ + provider,
 * so local-vs-cloud for the NEXT turn is always visible before you press send. The
 * first-use confirm + cost surfacing happen in App/thread, not here.
 */
function EscalateChip({
  providers,
  escalateTarget,
  onSelectEscalation,
  onOpenSettings,
}: {
  providers: ProviderMeta[];
  escalateTarget: EscalateTarget | null;
  onSelectEscalation(target: EscalateTarget | null): void;
  onOpenSettings(): void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useCloseOnOutside(() => setOpen(false));

  if (providers.length === 0) {
    return (
      <button
        type="button"
        className="chip dashed"
        title="Add a cloud provider in Settings to escalate (BYOK) — cost is surfaced before any outbound call (ADR-0002)"
        onClick={onOpenSettings}
      >
        <Cloud size={13} /> escalate
      </button>
    );
  }

  const active = escalateTarget
    ? providers.find((p) => p.id === escalateTarget.providerId) ?? null
    : null;

  return (
    <span className="menu-wrap" ref={ref}>
      <button
        type="button"
        className={`chip${active ? " cloud-armed" : ""}`}
        title={active ? `Next turn escalates to ${active.label}` : "Escalate the next turn to a cloud model"}
        onClick={() => setOpen((v) => !v)}
      >
        <Cloud size={13} /> {active ? truncate(active.label) : "escalate"} <ChevronDown size={13} />
      </button>
      {open ? (
        <div className="menu">
          <button
            type="button"
            className={`menu-item${escalateTarget === null ? " selected" : ""}`}
            onClick={() => {
              onSelectEscalation(null);
              setOpen(false);
            }}
          >
            {escalateTarget === null ? <Check size={13} /> : <span style={{ width: 13 }} />}
            <HardDrive size={13} /> Local (Ollama)
          </button>
          {providers.map((p) => (
            <button
              type="button"
              key={p.id}
              className={`menu-item${escalateTarget?.providerId === p.id ? " selected" : ""}`}
              disabled={!p.hasKey || !p.model}
              title={!p.hasKey ? "No key stored" : !p.model ? "No model set" : `${p.label} · ${p.model}`}
              onClick={() => {
                onSelectEscalation({ providerId: p.id, model: p.model });
                setOpen(false);
              }}
            >
              {escalateTarget?.providerId === p.id ? <Check size={13} /> : <span style={{ width: 13 }} />}
              <Cloud size={13} /> {p.label}
              <span className="menu-sub">{p.model || "no model"}</span>
            </button>
          ))}
          <button
            type="button"
            className="menu-item"
            onClick={() => {
              onOpenSettings();
              setOpen(false);
            }}
          >
            <Settings size={13} /> Manage providers…
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
