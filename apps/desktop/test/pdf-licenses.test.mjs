import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");

test("pdfjs-dist LICENSE and NOTICE ship with the packaged app", () => {
  const license = readFileSync(join(desktop, "licenses/pdfjs-dist/LICENSE"), "utf8");
  const notice = readFileSync(join(desktop, "licenses/pdfjs-dist/NOTICE"), "utf8");
  const listing = readFileSync(join(desktop, "licenses/THIRD-PARTY-NOTICES.txt"), "utf8");
  const builder = readFileSync(join(desktop, "electron-builder.yml"), "utf8");
  const liberation = readFileSync(join(desktop, "licenses/pdfjs-dist/LICENSE_LIBERATION"), "utf8");
  const foxit = readFileSync(join(desktop, "licenses/pdfjs-dist/LICENSE_FOXIT"), "utf8");

  assert.match(license, /Apache License/);
  assert.match(license, /Version 2\.0/);
  assert.match(notice, /Mozilla Foundation/);
  assert.match(notice, /Apache License, Version 2\.0/);
  assert.match(listing, /pdfjs-dist 5\.4\.296/);
  assert.match(listing, /Apache-2\.0/);
  assert.match(listing, /licenses\/pdfjs-dist\/LICENSE/);
  assert.match(listing, /licenses\/pdfjs-dist\/NOTICE/);
  assert.match(liberation, /SIL Open Font License/);
  assert.match(foxit, /PDFium Authors/);
  assert.match(builder, /extraResources:/);
  assert.match(builder, /from: licenses/);
  assert.match(builder, /to: licenses/);
  assert.match(builder, /pdfjs-dist/);
});
