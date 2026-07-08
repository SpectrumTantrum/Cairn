# Spike: pdf.js `getTextContent` + column-aware reading order (auto-graded)

> ⚠️ **VERDICT UNDER REVIEW (2026-06-14):** this spike's PASS is a **synthetic happy path** — it validates the column sort on a perfect in-memory PDF and OCR routing as "zero text items → flag." Robust real-PDF extraction / OCR routing is unproven. See [`docs/spike-verdicts-correction.md`](../../docs/spike-verdicts-correction.md).

## What this proves

Cairn's locked PDF pipeline (ADR-0004) extracts born-digital pages with pdf.js
`getTextContent` + a **reading-order sort**, and escalates image-only/scanned
pages to OCR (Tesseract WASM). This spike stress-tests the *born-digital half*
and answers two questions **programmatically** (no eyeballing):

> 1. Does a column-aware reading-order sort read a two-column page **one full
>    column at a time, top-to-bottom**, instead of zig-zagging left/right line by
>    line (the classic naive-sort failure)?
> 2. Does an image-only page get **flagged for the OCR path**?

It is **self-contained**: it builds its own fixture PDF in memory with
`pdf-lib` (MIT) — no data files, no manual setup. Three pages:

1. **single-column** text page (easy baseline),
2. **two-column** page — text in two distinct x-bands separated by a gutter
   (the hard case where naive y-desc/x-asc interleaves left/right),
3. **image-only** page — a drawn rectangle, no text (the OCR-escalation trigger).

For each page it prints the **naive** order (pure y-desc, x-asc, columns
ignored) and the **column-aware** order (gutter-detected bands, ordered within,
left→right) side by side, then asserts the result against the known fixture
layout and prints a **PASS/FAIL** verdict.

The column-aware sort detects columns by the **largest gap in x-origins**
(gutter detection), not a hardcoded midpoint — so a single-column page with no
real gutter degrades cleanly to one column, and the two-column split is found
wherever the gutter actually is.

## Run

```bash
cd spikes/pdf-extraction
npm install
npm start        # or: node extract.mjs
```

No arguments, no env vars, no PDFs to supply. Exits **0** on PASS, **1** on FAIL.

## PASS / FAIL (decided programmatically)

**PASS** requires all of:
- **page 1** single-column extracts `S1..S4` in order;
- **page 2** column-aware order emits the **entire LEFT column (L1..L4) before
  the entire RIGHT column (R1..R4)** — no interleaving — and each column reads
  top-to-bottom;
- **page 2** the **naive** order *does* interleave (`L1,R1,L2,R2,…`) — this is a
  guard that the column sort is actually doing the work, not coincidentally
  matching a trivial sort;
- **page 3** image-only page is **flagged `ocr:true`** (joined text below the
  empty-text threshold → routed to the OCR path).

Any failed assertion prints `[FAIL] …`, the overall verdict is **FAIL**, and the
process exits non-zero.

## What is real vs. simplified

- **Real (and graded):** in-memory fixture generation (pdf-lib), per-page
  `getTextContent`, the bottom-left PDF-space y-desc/x-asc sort with a **stable
  tie-break** (total order — matters for G7 extraction determinism),
  gutter-detected column banding, empty-page→OCR flag, and the
  assert-against-known-text verdict.
- **Simplified (honest scope):** fixtures are synthetic single-line-per-row text
  drawn at known baselines — they exercise reading-order/interleaving and the
  OCR trigger, **not** real-world hazards like hyphenation, rotated text,
  tables, ligatures, or three+ irregular columns. The gutter heuristic is a
  single-gap split (one gutter); multi-column pages with several gutters or
  ragged single columns would need the histogram/x-clustering extension noted in
  `extract.mjs`. This validates the ADR-0004 mechanism on the decisive failure
  modes; it is not a guarantee on arbitrary academic PDFs.
