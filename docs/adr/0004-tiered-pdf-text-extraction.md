# Tiered PDF text extraction: pdf.js text layer → Tesseract OCR → vision-model escalation

Cairn extracts text from PDFs in tiers that mirror ADR-0002's "cheap local default, escalate only when needed" model. **Born-digital** pages use pdf.js `getTextContent` (already in the stack for the viewer) plus a reading-order sort. **Image-only / scanned** pages are OCR'd at index time with **Tesseract** (`tesseract.js`, Apache-2.0 — in-process WASM, no Python). Pages Tesseract handles poorly (handwriting, messy photos, hard multi-column layout) can **escalate to a vision model** (BYOK cloud or a local Qwen-VL on capable tiers) through the existing `ModelGateway`. We do this because the primary user's real materials include scanned PDFs, which under the PRD's original "OCR out of scope, detect-and-warn" stance would be unsearchable *and* un-highlightable — so that stance is **superseded for v1**.

## Considered options

- **Detect-and-warn only** (PRD §6.2 original): simplest, but leaves scanned materials dead weight — unacceptable given scans are part of the primary user's workflow. Rejected.
- **Vision-model OCR as the default for every page:** best quality on hard layouts, but running every page through a model breaks background-indexing speed, the "100% offline & free on local models" promise, and student-hardware fit, and costs real money/time at index time. Rejected as default; kept as opt-in escalation.
- **Docling / Python sidecar** (ADR-0001's documented escape hatch): best layout + OCR in one tool, but reintroduces the Python runtime ADR-0001 deliberately eliminated. Rejected for v1; remains the deferred fallback if extraction quality proves unusable. — **Amended by ADR-0009 (2026-07-07):** a bundled Python ingestion sidecar (Docling + whisper.cpp) now ships in v1 for multi-format parsing + AV transcription, so the "no Python runtime" premise here is relaxed — scoped to **ingestion only**, with the retrieval core staying TS in-process. This does not by itself retire the tiered pdf.js → Tesseract → vision path below; whether Docling supplants pdf.js as Cairn's *PDF text* source for indexing is left open (see ADR-0009 and the flag in that ADR's rollout).
- **Tiered (chosen):** pdf.js text for born-digital + Tesseract for printed scans + vision escalation for hard pages. Honors the one-language/in-process invariant for the common case; pays for a model only on the pages that need it.

## Consequences

- New permissive dependency: **`tesseract.js` (Apache-2.0)** + English language data (~10–15 MB) bundled with the app. No Python — the ADR-0001 invariant holds.
- OCR runs **in the background at index time** on only the image-only pages (detected via empty/near-empty `getTextContent`); never blocks the UI.
- Chunks carry an **`ocr: true`** flag; the reader/UI surfaces "scanned — text may be imperfect." Retrieval on OCR'd pages is weaker, and **page-level citations** (Cairn's chosen PDF citation granularity) absorb the noise — you cite the page, the user sees it.
- The vision-OCR tier reuses `ModelGateway` + ADR-0002's cost-surfaced escalation. **Open scope detail:** whether the vision tier ships in v1.0 or as a fast-follow depends on how prevalent handwriting is in the user's scans — Tesseract is weak on handwriting and non-Latin scripts, which are exactly the escalation triggers.
