// Spike: is pdf.js `getTextContent` + a reading-order sort good enough on
// multi-column PDFs, and does the image-only page correctly fire the OCR path?
//
// Cairn's locked PDF path (ADR-0004) is: pdf.js getTextContent for born-digital
// pages + a reading-order sort, with image-only pages escalated to the OCR path
// (Tesseract WASM). This harness exercises exactly the born-digital half and
// AUTO-GRADES it against fixtures whose layout & text we author here, so there is
// no eyeballing and no manual data entry.
//
// It builds three fixture PDFs at runtime with pdf-lib (MIT):
//   1) a SINGLE-COLUMN text page (easy baseline),
//   2) a TWO-COLUMN page (text in two distinct x-bands with a clear gutter) —
//      the hard case where naive y-desc/x-asc interleaves left/right,
//   3) an IMAGE-ONLY page (a drawn rectangle, NO text) — the OCR-escalation trigger.
//
// For each page it prints NAIVE vs COLUMN-AWARE reading order, flags the
// image-only page for OCR, then asserts:
//   - the two-column page, in COLUMN-AWARE mode, reads the whole left column
//     top-to-bottom THEN the whole right column top-to-bottom (no interleaving),
//   - the naive order DOES interleave (proves the column sort buys something),
//   - the image-only page is flagged ocr:true.
// Prints a programmatic PASS/FAIL verdict and exits non-zero on FAIL.
//
// House style: ESM (.mjs), self-contained package.json, legacy ESM build of
// pdf.js (matches spikes/pdfjs/coords.mjs which uses 6.x), pdf-lib for fixtures
// (matches spikes/pdfjs). No Ollama / no embedder — this spike is pure extraction.
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Where pdf.js finds Foxit substitutes for the 14 standard PDF fonts (Helvetica
// etc.). Pointing at it just silences a cosmetic "standardFontDataUrl not
// provided" warning; extraction works either way. Trailing slash is required.
const STD_FONTS = join(
  dirname(fileURLToPath(import.meta.url)),
  'node_modules/pdfjs-dist/standard_fonts/',
);

// A page whose joined text is shorter than this (after trim) is treated as
// image-only / scanned -> would be routed to the OCR path (ADR-0004).
const EMPTY_TEXT_THRESHOLD = 8;

// US Letter in PDF points (origin BOTTOM-LEFT).
const PAGE_W = 612, PAGE_H = 792;

// ---------------------------------------------------------------------------
// FIXTURE TEXT (the ground truth the grader checks against).
// Tokens are tagged L#/R#/S# so we can assert exact reading order from the
// extracted stream without depending on pdf.js's exact whitespace.
// ---------------------------------------------------------------------------
const SINGLE = [
  'S1 Cairn keeps your study vault in plain markdown files.',
  'S2 Born-digital PDFs are extracted with the text layer.',
  'S3 Image-only pages escalate to the OCR path at index time.',
  'S4 Page-level citations absorb extractor noise per ADR-0004.',
];
// Two distinct vertical bands. The grader requires column-aware order to emit
// ALL of LEFT (top->bottom) before ALL of RIGHT (top->bottom).
const LEFT = [
  'L1 Local-first means no telemetry and no cloud calls.',
  'L2 The vault is the source of truth on disk.',
  'L3 Embeddings cache by chunk content hash.',
  'L4 Switching embedder reuses extraction and chunking.',
];
const RIGHT = [
  'R1 Retrieval fuses dense vectors with BM25 via RRF.',
  'R2 sqlite-vec is a brute-force KNN scan at v1 scale.',
  'R3 Citations jump to the exact source span.',
  'R4 Only permissive-licensed dependencies are allowed.',
];

// ---------------------------------------------------------------------------
// Build the fixture PDF in memory with pdf-lib. Each line is drawn as its own
// drawText call at a known (x,y) baseline so the layout is exactly what we sort.
// ---------------------------------------------------------------------------
async function buildFixturePdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const SIZE = 11, LEAD = 22; // point size + line leading

  // Page 1: single column, left margin, lines marching down the page.
  const p1 = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - 72;
  for (const line of SINGLE) {
    p1.drawText(line, { x: 72, y, size: SIZE, font });
    y -= LEAD;
  }

  // Page 2: two columns. LEFT band x=72 (well left of midpoint=306),
  // RIGHT band x=340 (well right of the gutter). Both start at the same top y
  // and march down — this is precisely the layout where pure y-desc/x-asc
  // interleaves "L1, R1, L2, R2, ...".
  const p2 = doc.addPage([PAGE_W, PAGE_H]);
  const LX = 72, RX = 340, TOP = PAGE_H - 72;
  y = TOP;
  for (const line of LEFT) { p2.drawText(line, { x: LX, y, size: SIZE, font }); y -= LEAD; }
  y = TOP;
  for (const line of RIGHT) { p2.drawText(line, { x: RX, y, size: SIZE, font }); y -= LEAD; }

  // Page 3: image-only — a drawn rectangle, NO text at all.
  const p3 = doc.addPage([PAGE_W, PAGE_H]);
  p3.drawRectangle({ x: 150, y: 300, width: 300, height: 200 });

  return doc.save(); // Uint8Array
}

// ---------------------------------------------------------------------------
// Reading-order sorts. pdf.js item.transform = [a,b,c,d,e,f]; (e,f) is the glyph
// run origin in PDF space, ORIGIN BOTTOM-LEFT. So reading order is y DESCENDING
// (top of page first) then x ASCENDING (left to right). Ties are broken by the
// original item index to keep the sort TOTAL/STABLE (G7 determinism note:
// equal-coordinate tie-breaking must not be a nondeterminism source).
// ---------------------------------------------------------------------------
function itemXY(item) {
  const t = item.transform || [1, 0, 0, 1, 0, 0];
  return { x: t[4], y: t[5] };
}

const Y_EPS = 2; // glyph runs within this many points share a baseline / "line"

function byReadingOrder(a, b) {
  if (Math.abs(a.y - b.y) > Y_EPS) return b.y - a.y; // higher y first (top of page)
  if (a.x !== b.x) return a.x - b.x;                 // then left to right
  return a.i - b.i;                                  // stable tie-break (total order)
}

// Naive order: pure y-desc then x-asc, columns ignored.
function naiveOrder(items) {
  return [...items].sort(byReadingOrder);
}

// Column-aware order: detect columns by the LARGEST GAP in the sorted x-origins
// (gutter detection), bucket items into bands, order within each band, concat
// left-to-right. This is the "switch to gutter detection" path the spike README
// promised — it does NOT hardcode a midpoint, so it also degrades gracefully to
// a single column when no real gutter exists (single-column page stays intact).
function detectColumnBands(items, pageWidth) {
  const xs = [...new Set(items.map((it) => it.x))].sort((a, b) => a - b);
  if (xs.length < 2) return null; // one x cluster -> single column
  // Find the biggest gap between consecutive distinct x-origins.
  let gap = 0, splitAt = null;
  for (let k = 1; k < xs.length; k++) {
    const g = xs[k] - xs[k - 1];
    if (g > gap) { gap = g; splitAt = (xs[k] + xs[k - 1]) / 2; }
  }
  // A real gutter is a large fraction of the page width; otherwise it's just
  // intra-line jitter (e.g. a single column with ragged starts) -> 1 column.
  if (gap < pageWidth * 0.15) return null;
  // EXTENSION (not needed for these fixtures): this is a SINGLE-gap split (one
  // gutter / two columns). For 3+ columns or ragged single columns, replace
  // with an x-origin histogram + multi-gap banding (or 1-D clustering).
  return [splitAt];
}

function columnOrder(items, pageWidth) {
  const splits = detectColumnBands(items, pageWidth);
  if (!splits) return naiveOrder(items); // single column
  const split = splits[0];
  const leftBand = items.filter((it) => it.x < split).sort(byReadingOrder);
  const rightBand = items.filter((it) => it.x >= split).sort(byReadingOrder);
  return [...leftBand, ...rightBand];
}

function joinItems(items) {
  // Crude join: newline when y drops, space otherwise. Good enough to eyeball
  // ordering; NOT the real chunker's whitespace logic.
  let out = '';
  let prevY = null;
  for (const it of items) {
    if (prevY !== null && Math.abs(it.y - prevY) > Y_EPS) out += '\n';
    else if (out) out += ' ';
    out += it.str;
    prevY = it.y;
  }
  return out;
}

function indent(text) {
  return text.split('\n').map((l) => '    | ' + l).join('\n');
}

// Extract pdf.js text items into a plain shape (str + x/y + original index).
async function pageItems(page) {
  const tc = await page.getTextContent();
  return tc.items
    .filter((i) => typeof i.str === 'string')
    .map((i, idx) => ({ str: i.str, ...itemXY(i), i: idx }));
}

// Pull the ordered list of fixture TAGS (L1/R1/S1/...) out of a token stream,
// so order assertions don't depend on pdf.js's exact word boundaries.
const TAG_RE = /\b([LRS]\d)\b/g;
function tagsInOrder(items) {
  const tags = [];
  for (const it of items) {
    let m;
    while ((m = TAG_RE.exec(it.str)) !== null) tags.push(m[1]);
  }
  return tags;
}

function isSorted(nums) {
  for (let k = 1; k < nums.length; k++) if (nums[k] < nums[k - 1]) return false;
  return true;
}

async function main() {
  console.log('Spike: pdf.js getTextContent + column-aware reading-order sort (auto-graded)');
  console.log(`pdfjs-dist version: ${pdfjs.version}`);
  console.log('fixtures: generated in-memory with pdf-lib (single-col / two-col / image-only)\n');

  const bytes = await buildFixturePdf();
  const pdf = await pdfjs.getDocument({ data: bytes, standardFontDataUrl: STD_FONTS }).promise;

  const failures = [];
  const results = {}; // page number -> data we assert on

  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const viewport = page.getViewport({ scale: 1 });
    const items = await pageItems(page);

    const naive = naiveOrder(items);
    const cols = columnOrder(items, viewport.width);
    const colText = joinItems(cols);
    const imageOnly = colText.trim().length < EMPTY_TEXT_THRESHOLD;

    console.log(`-- page ${n}  (${items.length} text items, width=${viewport.width.toFixed(0)}) --`);
    if (imageOnly) {
      console.log('  >> EMPTY/IMAGE-ONLY PAGE -> would route to OCR path (ocr:true, ADR-0004)\n');
      results[n] = { imageOnly: true };
      continue;
    }

    console.log('  [NAIVE y-desc,x-asc — ignores columns]');
    console.log(indent(joinItems(naive)));
    console.log('\n  [COLUMN-AWARE — gutter-detected bands, L->R]');
    console.log(indent(colText));
    console.log('');

    results[n] = {
      imageOnly: false,
      naiveTags: tagsInOrder(naive),
      colTags: tagsInOrder(cols),
    };
  }

  // -------------------------------------------------------------------------
  // VERDICT — programmatic assertions against the known fixtures.
  // -------------------------------------------------------------------------
  console.log('='.repeat(72));
  console.log('VERDICT (auto-graded against known fixture layout)');
  console.log('='.repeat(72));

  const check = (label, ok, detail = '') => {
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? '  — ' + detail : ''}`);
    if (!ok) failures.push(label);
  };

  // Page 1 — single column extracts intact, in order.
  const p1 = results[1] || {};
  check(
    'page1 single-column reads S1..S4 in order',
    !p1.imageOnly && JSON.stringify(p1.colTags) === JSON.stringify(['S1', 'S2', 'S3', 'S4']),
    `got ${JSON.stringify(p1.colTags)}`,
  );

  // Page 2 — the load-bearing check.
  const p2 = results[2] || {};
  const colTags = p2.colTags || [];
  const lefts = colTags.filter((t) => t[0] === 'L');
  const rights = colTags.filter((t) => t[0] === 'R');
  const leftNums = lefts.map((t) => Number(t.slice(1)));
  const rightNums = rights.map((t) => Number(t.slice(1)));
  // No interleaving: every L tag comes before every R tag in the stream.
  const lastL = colTags.lastIndexOf(lefts[lefts.length - 1]);
  const firstR = colTags.indexOf(rights[0]);
  const noInterleave =
    lefts.length === 4 && rights.length === 4 && lastL < firstR;
  check(
    'page2 column-aware: full LEFT column before full RIGHT column (no interleaving)',
    noInterleave,
    `order ${JSON.stringify(colTags)}`,
  );
  check(
    'page2 column-aware: each column reads top-to-bottom (L1..L4, R1..R4)',
    isSorted(leftNums) && isSorted(rightNums) &&
      JSON.stringify(leftNums) === JSON.stringify([1, 2, 3, 4]) &&
      JSON.stringify(rightNums) === JSON.stringify([1, 2, 3, 4]),
    `L=${JSON.stringify(leftNums)} R=${JSON.stringify(rightNums)}`,
  );
  // Sanity: the NAIVE order should interleave on this layout — proves the
  // column sort is actually doing work (if naive already passed, the test
  // wouldn't be exercising column logic).
  const naiveTags = p2.naiveTags || [];
  const naiveInterleaves = (() => {
    // interleaved if an R appears before the last L
    const lastLn = naiveTags.map((t) => t[0]).lastIndexOf('L');
    const firstRn = naiveTags.map((t) => t[0]).indexOf('R');
    return firstRn !== -1 && lastLn !== -1 && firstRn < lastLn;
  })();
  check(
    'page2 naive order DOES interleave (column sort is load-bearing)',
    naiveInterleaves,
    `naive ${JSON.stringify(naiveTags)}`,
  );

  // Page 3 — image-only must be flagged for OCR.
  const p3 = results[3] || {};
  check('page3 image-only page is flagged for the OCR path (ocr:true)', p3.imageOnly === true);

  console.log('');
  if (failures.length === 0) {
    console.log('OVERALL: PASS — pdf.js getTextContent + gutter-aware column sort reads each');
    console.log('column top-to-bottom without interleaving, and the image-only page is flagged');
    console.log('for OCR. ADR-0004 born-digital extraction + OCR-escalation trigger validated.');
    process.exit(0);
  } else {
    console.log(`OVERALL: FAIL — ${failures.length} check(s) failed:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
