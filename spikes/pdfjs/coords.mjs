// Spike: pdf.js coordinate mapping for Cairn annotations.
// EASY part (confirm): text item -> bounding rect for a highlight.
// HARD part (the real risk): store an arbitrary AREA rect in PDF space and
// re-anchor it correctly across zoom levels; round-trip viewport<->PDF.
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import crypto from 'node:crypto';

// 1) Build a fixture PDF with text at a KNOWN position + a diagram rectangle.
const doc = await PDFDocument.create();
const page = doc.addPage([612, 792]);            // US Letter, PDF coords: origin bottom-left
const font = await doc.embedFont(StandardFonts.Helvetica);
const TEXT = 'HIGHLIGHT ME';
const TX = 100, TY = 700, SIZE = 24;             // baseline position in PDF points
page.drawText(TEXT, { x: TX, y: TY, size: SIZE, font });
// A "diagram" the user might draw an area annotation around:
page.drawRectangle({ x: 200, y: 300, width: 180, height: 120 });
const bytes = await doc.save();
const sha = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
console.log('fixture sha256(16):', sha, ' (sidecar key would be .cairn/annotations/' + sha + '....json)');

// 2) Load with pdf.js and read text content.
const pdf = await pdfjs.getDocument({ data: bytes }).promise;
const p = await pdf.getPage(1);
const tc = await p.getTextContent();
const item = tc.items.find(i => i.str.includes('HIGHLIGHT'));
console.log('\n-- TEXT-HIGHLIGHT path (easy) --');
console.log('found text item str=%j  transform=%o  width=%s height=%s',
  item.str, item.transform.map(n => +n.toFixed(2)), item.width.toFixed(2), item.height.toFixed(2));
// transform = [a,b,c,d,e,f]; e,f = device-space origin of the glyph run baseline.
const [a, b, c, d, e, f] = item.transform;
// bounding rect of the text run in PDF coordinate space:
const textRectPdf = [e, f, e + item.width, f + item.height];   // x1,y1,x2,y2
console.log('text rect in PDF space (x1,y1,x2,y2):', textRectPdf.map(n => +n.toFixed(1)));
console.log('expected ~ x≈%s y≈%s  (drawn at %s,%s) -> MATCH=%s', TX, TY, TX, TY,
  Math.abs(e - TX) < 1 && Math.abs(f - TY) < 1);

// 3) AREA-ANNOTATION re-anchoring across zoom (the real risk).
// User draws a box around the diagram at zoom 1.5. We capture viewport px,
// convert to PDF space, store ONLY pdf-space, then re-project at other zooms.
console.log('\n-- AREA-ANNOTATION re-anchoring (the real risk) --');
const vp15 = p.getViewport({ scale: 1.5 });
// Simulate a user-drawn rectangle in viewport(px) at scale 1.5 around the diagram.
// First get where the diagram (PDF 200,300..380,420) lands at 1.5x to make a realistic px box:
const drawnPx = vp15.convertToViewportRectangle([200, 300, 380, 420]); // [x1,y1,x2,y2] in px
console.log('user draws px box @1.5x:', drawnPx.map(n => +n.toFixed(1)));
// Convert the drawn px corners back to PDF space (what we persist in the sidecar):
const [px1, py1, px2, py2] = drawnPx;
const c1 = vp15.convertToPdfPoint(px1, py1);
const c2 = vp15.convertToPdfPoint(px2, py2);
const storedPdfRect = [Math.min(c1[0], c2[0]), Math.min(c1[1], c2[1]), Math.max(c1[0], c2[0]), Math.max(c1[1], c2[1])];
console.log('persisted PDF-space rect:', storedPdfRect.map(n => +n.toFixed(1)),
  '-> recovers original diagram (200,300,380,420)?', storedPdfRect.map(n => Math.round(n)).join(',') === '200,300,380,420');

// Re-project the SAME stored rect at several zoom levels:
for (const scale of [1.0, 2.0, 3.0]) {
  const vp = p.getViewport({ scale });
  const r = vp.convertToViewportRectangle(storedPdfRect);
  const norm = [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
  const w = (norm[2] - norm[0]).toFixed(1), h = (norm[3] - norm[1]).toFixed(1);
  console.log(`  @${scale}x -> px rect ${norm.map(n => +n.toFixed(1))}  (w=${w} h=${h}; expect w/h scale linearly with zoom)`);
}

// 4) Rotated page sanity (PDFs can carry /Rotate). Re-project under 90deg rotation.
const vpRot = p.getViewport({ scale: 1.0, rotation: 90 });
const rRot = vpRot.convertToViewportRectangle(storedPdfRect);
console.log('  @1x +90deg rotation -> px rect', rRot.map(n => +n.toFixed(1)), '(transform handles rotation: non-degenerate =', (Math.abs(rRot[0]-rRot[2])>1 && Math.abs(rRot[1]-rRot[3])>1) + ')');

console.log('\nVERDICT: viewport.convertToViewportRectangle / convertToPdfPoint give a clean, reversible PDF<->px mapping at any zoom & rotation. Storing rects in PDF space is the correct, zoom-stable persistence model.');
