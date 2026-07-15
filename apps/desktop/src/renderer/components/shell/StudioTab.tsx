import { useState, type ComponentType } from "react";
import {
  BookOpen,
  ChevronRight,
  Clock,
  FileText,
  HelpCircle,
  Layers,
  ListChecks,
  Network,
  Sparkles,
} from "lucide-react";
import type { StudioTemplateMeta } from "../../../shared/types.js";

/**
 * Studio grounded-output generators (issue #26). Cards — their titles, descriptions, icons,
 * and enabled state — now come from the ENGINE template registry (via `studio:templates`);
 * this component only renders them. Exactly one template (Study Guide) is enabled this slice;
 * the other six render disabled with a `needs` tooltip. Adding a future generator is a
 * registry entry + prompt in the engine, not a change here.
 */

/** Map a registry icon name to its lucide component. Unknown names fall back to Sparkles. */
const ICONS: Record<string, ComponentType<{ size?: number }>> = {
  BookOpen,
  FileText,
  HelpCircle,
  Clock,
  Network,
  Layers,
  ListChecks,
};

interface StudioTabProps {
  templates: StudioTemplateMeta[];
  busy: boolean;
  /** True when there is no vault / no index / Ollama is down — generation can't run. */
  disabled: boolean;
  disabledReason: string | null;
  /** Active source scope size (0 = whole vault). Surfaced so the user knows what's in scope. */
  scopeCount: number;
  onGenerate(templateId: string, topic: string): void;
}

export function StudioTab({ templates, busy, disabled, disabledReason, scopeCount, onGenerate }: StudioTabProps) {
  return (
    <div className="studio-body">
      {scopeCount > 0 ? (
        <p className="studio-scope-hint">
          Scoped to {scopeCount} source{scopeCount === 1 ? "" : "s"} — uncheck sources in the Sources tab to narrow.
        </p>
      ) : null}
      <div className="studio-grid">
        {templates.map((template) =>
          template.enabled ? (
            <EnabledCard
              key={template.id}
              template={template}
              busy={busy}
              disabled={disabled}
              disabledReason={disabledReason}
              onGenerate={onGenerate}
            />
          ) : (
            <DisabledCard key={template.id} template={template} />
          ),
        )}
      </div>
    </div>
  );
}

/** An active generator: title, description, a topic field, and a Generate button. */
function EnabledCard({
  template,
  busy,
  disabled,
  disabledReason,
  onGenerate,
}: {
  template: StudioTemplateMeta;
  busy: boolean;
  disabled: boolean;
  disabledReason: string | null;
  onGenerate(templateId: string, topic: string): void;
}) {
  const [topic, setTopic] = useState("");
  const Icon = ICONS[template.icon] ?? Sparkles;
  const canRun = !disabled && !busy && topic.trim().length > 0;

  function submit(): void {
    if (!canRun) return;
    onGenerate(template.id, topic.trim());
    setTopic("");
  }

  return (
    <div className="studio-card enabled" title={disabled ? disabledReason ?? undefined : undefined}>
      <div className="studio-card-top">
        <Icon size={18} />
        <span className="studio-card-title">{template.title}</span>
      </div>
      <p className="studio-card-desc">{template.description}</p>
      <input
        type="text"
        className="studio-topic-input"
        placeholder="Topic to build a study guide on…"
        value={topic}
        disabled={disabled || busy}
        onChange={(e) => setTopic(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
      />
      <button
        type="button"
        className="studio-generate-btn"
        disabled={!canRun}
        title={disabled ? disabledReason ?? undefined : "Generate a grounded, cited note"}
        onClick={submit}
      >
        <Sparkles size={14} /> {busy ? "Generating…" : "Generate"}
      </button>
    </div>
  );
}

/** A not-yet-shipped generator: keyboard-focusable but inert, with a "coming soon" tooltip. */
function DisabledCard({ template }: { template: StudioTemplateMeta }) {
  const Icon = ICONS[template.icon] ?? Sparkles;
  return (
    <div
      className="studio-card"
      role="button"
      aria-disabled="true"
      tabIndex={0}
      title={`Coming soon — needs ${template.needs ?? "more work"}`}
    >
      <div className="studio-card-top">
        <Icon size={18} />
        <ChevronRight size={16} />
      </div>
      <span className="studio-card-title">{template.title}</span>
    </div>
  );
}
