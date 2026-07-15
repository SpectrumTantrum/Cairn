// Studio template registry (issue #26). Templates are DATA, not code: adding one of the
// remaining six generators is a new ENTRY here (plus its prompt scaffold) — never new
// plumbing. The shared grounded-generation pipeline (studio-generate.ts), the write-safety
// apply path (ADR-0008), and the desktop cards all read this one registry.
//
// This slice ships exactly ONE enabled template (Study Guide). The other six are registered
// but `enabled: false` so the desktop can render their (disabled, "coming soon") cards from
// the same source of truth, each with a `needs` note explaining what still has to land.

/** The grounded-generation scaffold for an enabled template. */
export interface StudioPrompt {
  /**
   * Template-specific STRUCTURE guidance, appended to the shared grounding rules. Tells the
   * model what sections to produce; the pipeline still enforces citation provenance itself
   * (it appends a deterministic "## Sources" block regardless of what the model emits).
   */
  structure: string;
  /** Human-readable filename stem for the generated note (before the topic + any collision suffix). */
  filenameStem: string;
}

export interface StudioTemplate {
  /** Stable id — the IPC/registry key (e.g. "study-guide"). */
  id: string;
  title: string;
  description: string;
  /** lucide-react icon NAME; the renderer maps it to a component so the engine stays React-free. */
  icon: string;
  /** Only enabled templates run this slice; disabled ones render as coming-soon cards. */
  enabled: boolean;
  /** What still has to land before a disabled generator can ship (card tooltip). */
  needs?: string;
  /** Present on enabled templates only — the grounded-generation scaffold. */
  prompt?: StudioPrompt;
}

/** Renderer-safe template metadata — the registry minus the prompt scaffold. */
export interface StudioTemplateMeta {
  id: string;
  title: string;
  description: string;
  icon: string;
  enabled: boolean;
  needs?: string;
}

export const STUDIO_TEMPLATES: StudioTemplate[] = [
  {
    id: "study-guide",
    title: "Study Guide",
    description:
      "A structured guide over the selected sources — overview, key concepts, and self-check questions, every claim cited.",
    icon: "BookOpen",
    enabled: true,
    prompt: {
      structure: [
        "Produce a STUDY GUIDE with exactly these Markdown sections, in this order:",
        "## Overview — 2 to 4 sentences framing the topic; cite the source of each claim.",
        "## Key concepts — a bulleted list. Each bullet names one concept, explains it in one or two sentences, and cites the source(s) it is drawn from.",
        "## Self-check questions — 3 to 6 questions the reader can use to test recall, each grounded in the sources.",
        "Do NOT write your own Sources list — a cited Sources section is appended for you.",
      ].join("\n"),
      filenameStem: "Study Guide",
    },
  },
  {
    id: "briefing",
    title: "Briefing",
    description: "A concise briefing document synthesised from the selected sources.",
    icon: "FileText",
    enabled: false,
    needs: "grounded generation",
  },
  {
    id: "faq",
    title: "FAQ",
    description: "Frequently-asked questions answered from the selected sources.",
    icon: "HelpCircle",
    enabled: false,
    needs: "grounded generation",
  },
  {
    id: "timeline",
    title: "Timeline",
    description: "A chronological timeline extracted from the selected sources.",
    icon: "Clock",
    enabled: false,
    needs: "grounded generation",
  },
  {
    id: "mind-map",
    title: "Mind Map",
    description: "An interactive concept graph over the selected sources.",
    icon: "Network",
    enabled: false,
    needs: "interactive graph output",
  },
  {
    id: "flashcards",
    title: "Flashcards",
    description: "Question/answer flashcards generated from the selected sources.",
    icon: "Layers",
    enabled: false,
    needs: "grounded generation",
  },
  {
    id: "quiz",
    title: "Quiz",
    description: "An interactive quiz with explanations for wrong answers.",
    icon: "ListChecks",
    enabled: false,
    needs: "interactive quiz output",
  },
];

/** Look a template up by id. */
export function getStudioTemplate(id: string): StudioTemplate | undefined {
  return STUDIO_TEMPLATES.find((t) => t.id === id);
}

/** The registry as renderer-safe metadata (no prompt scaffolds cross the IPC boundary). */
export function studioTemplateMetas(): StudioTemplateMeta[] {
  return STUDIO_TEMPLATES.map(({ id, title, description, icon, enabled, needs }) => ({
    id,
    title,
    description,
    icon,
    enabled,
    needs,
  }));
}
