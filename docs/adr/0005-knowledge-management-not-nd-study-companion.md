# Cairn is a knowledge-management tool, not a neurodivergent study companion

Cairn is positioned as a **local-first agentic knowledge-management tool** — a fusion of **NotebookLM** (grounded Q&A + generated "studio" outputs), **Cursor** (agentic editing with task-scoped modes), and **Obsidian** (Markdown vault + graph). This **supersedes the PRD's framing** (§1/§3/§10), which made *neurodivergent-friendly pedagogy* "the product's identity" and targeted ADHD/autistic students specifically. The ND-specific mechanics — hint ladders, fixation guard, low-energy mode, and a "neurodivergent-friendly mode" toggle — are **out of scope.** The target broadens to anyone managing their own knowledge (the author remains the primary dogfood user).

## Why

- The PRD itself flagged the space as crowded (§13) and leaned on ND pedagogy as the moat. On reflection the durable differentiator is the **fusion + local-first/private + PDF-annotation↔vault citations** — a combination none of Khoj, Open Notebook, AnythingLLM, NotebookLM, or Obsidian offers *together*. The moat relocates there; it does not disappear.
- ND-specific pacing imposes opinionated behaviour (forced chunking, hint-gating) that not every knowledge worker wants, and it is a large surface for a solo build.

## What stays (this is good product, not "ND")

Accessibility (keyboard nav, screen-reader labels, WCAG-AA contrast, `prefers-reduced-motion`), predictable UI (no surprise modals/autoplay, actions announced), readable/chunked long output, an on-demand **Focus mode**, and "where you left off" session re-entry. These belong in any good KM tool and are **always on** — never a toggle.

## Consequences

- PRD §10 ("Neurodivergent-First UX … product identity") is superseded; `docs/v1-scope.md` is authoritative.
- **Tutor → Explain:** a grounded, cited walk-through of a concept from the user's own sources; no Socratic hint-ladder or fixation scaffolding.
- Persona P1 (ADHD/autistic student) broadens to general knowledge workers.
- An earlier draft of this ADR recorded an "ND-friendly mode toggle, default off" — that decision was reversed within the same session and is replaced by this repositioning.
