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
    enabled: true,
    prompt: {
      structure: [
        "Produce an executive BRIEFING with exactly these Markdown sections, in this order:",
        "## Context — 2 to 4 sentences framing the topic and why it matters; cite the source of each claim.",
        "## Key points — a bulleted list. Each bullet states one salient finding in one or two sentences and cites the source(s) it is drawn from.",
        "## Implications — 2 to 4 sentences on what the key points mean or what follows from them, each grounded in the sources.",
        "## Open questions — 2 to 5 questions the sources leave unresolved, each grounded in what the sources do (and do not) say.",
        "Do NOT write your own Sources list — a cited Sources section is appended for you.",
      ].join("\n"),
      filenameStem: "Briefing",
    },
  },
  {
    id: "faq",
    title: "FAQ",
    description: "Frequently-asked questions answered from the selected sources.",
    icon: "HelpCircle",
    enabled: true,
    prompt: {
      structure: [
        "Produce an FAQ as grounded question-and-answer pairs, ordered from the most fundamental question to the most advanced:",
        "Ask the questions a reader of these sources would actually have — the things the sources set out to explain — not trivia.",
        "Format each entry as a `### ` heading holding the question, followed by the answer in one or two sentences.",
        "Answer ONLY from the sources and cite each answer inline with bracketed numbers, e.g. [1] or [2][3].",
        "If the sources do not answer a question, do not invent one — leave it out rather than answering beyond the sources.",
        "Do NOT write your own Sources list — a cited Sources section is appended for you.",
      ].join("\n"),
      filenameStem: "FAQ",
    },
  },
  {
    id: "timeline",
    title: "Timeline",
    description: "A chronological timeline extracted from the selected sources.",
    icon: "Clock",
    enabled: true,
    prompt: {
      structure: [
        "Produce a TIMELINE with exactly these Markdown sections, in this order:",
        "## Timeline — a chronological sequence of the events and developments described in the sources, earliest first. Format each as a bulleted list item that begins with its date or ordering cue AS STATED IN THE SOURCES, then a one to two sentence description, and cites the source(s) the entry is drawn from.",
        "Use ONLY dates and time references that appear in the sources — never invent, infer, or approximate a date. When the sources give no explicit date for an event, order it by whatever relative sequencing they state and use relative ordering language (e.g. \"before\", \"after\", \"later\", \"subsequently\") instead of a fabricated date.",
        "## Gaps in the record — 1 to 3 sentences noting periods or transitions the sources do not cover, so the reader knows what the timeline leaves out.",
        "Do NOT write your own Sources list — a cited Sources section is appended for you.",
      ].join("\n"),
      filenameStem: "Timeline",
    },
  },
  {
    id: "mind-map",
    title: "Mind Map",
    description:
      "A hierarchical concept outline over the selected sources — a central topic branching into subtopics and leaf ideas, every branch cited.",
    icon: "Network",
    enabled: true,
    prompt: {
      structure: [
        "Produce a MIND MAP as a hierarchical Markdown OUTLINE — a text outline, NOT an interactive canvas or graph:",
        "## <central topic> — a single root heading naming the central topic of the map.",
        "### <main branch> — one subheading per major branch off the central topic; use several branches.",
        "Under each branch, nest bullets (and deeper sub-bullets) for the leaf ideas, indenting each level further.",
        "Keep every node a SHORT label — a few words, not sentences or paragraphs; favour breadth (many branches and leaves) over prose.",
        "Ground each branch and leaf in the sources and cite them inline with bracketed numbers, e.g. [1] or [2][3].",
        "Do NOT write your own Sources list — a cited Sources section is appended for you.",
      ].join("\n"),
      filenameStem: "Mind Map",
    },
  },
  {
    id: "flashcards",
    title: "Flashcards",
    description: "Question/answer flashcards generated from the selected sources.",
    icon: "Layers",
    enabled: true,
    prompt: {
      structure: [
        "Produce a DECK OF FLASHCARDS. Emit each card as a **Q:** line immediately followed by an **A:** line, with exactly ONE blank line between cards. Use this exact, regular format so a later exporter can parse the deck deterministically (do NOT number the cards, add headings, or wrap them in a list):",
        "**Q:** <the question>",
        "**A:** <the answer, with every claim cited inline as [1] or [2][3]>",
        "",
        "Rules for the deck:",
        "- One atomic fact per card — a single concept per question; split compound ideas into separate cards.",
        "- Mix straightforward recall questions with understanding questions (why/how/compare) that still resolve to a source-grounded answer.",
        "- Ground every answer in the sources and cite it inline; never write a card whose answer is not supported by the sources.",
        "- Keep the **Q:**/**A:** format byte-regular across all cards (no other Markdown structure between them).",
        "Do NOT write your own Sources list — a cited Sources section is appended for you.",
      ].join("\n"),
      filenameStem: "Flashcards",
    },
  },
  {
    id: "quiz",
    title: "Quiz",
    description:
      "A self-test quiz over the selected sources — multiple-choice and short-answer questions with a cited answer key.",
    icon: "ListChecks",
    enabled: true,
    prompt: {
      structure: [
        "Produce a QUIZ with exactly these Markdown sections, in this order:",
        "## Questions — a numbered list mixing multiple-choice and short-answer questions that cover the sources' key material. For each multiple-choice question, give exactly 4 options labelled A, B, C, D with exactly one correct. For each short-answer question, ask for a brief written response. Every question MUST be answerable from the sources alone — never require outside knowledge, and do NOT put citations in this section.",
        "## Answer Key — a numbered list matching the questions above. For each answer, state the correct option (or expected short answer) and cite the source(s) it is grounded in with bracketed numbers, e.g. [1] or [2][3].",
        "Do NOT write your own Sources list — a cited Sources section is appended for you.",
      ].join("\n"),
      filenameStem: "Quiz",
    },
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
