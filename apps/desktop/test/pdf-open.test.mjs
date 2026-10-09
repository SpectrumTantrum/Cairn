import assert from "node:assert/strict";
import { test } from "node:test";

const { pdfFileUrl } = await import("../out-test-pdf/pdf-open.js");

test("(a) the in-app PDF url requests #page=N", () => {
  const url = pdfFileUrl("/tmp/vault/report.pdf", 3);
  assert.equal(url.startsWith("file://"), true);
  assert.equal(url.includes("report.pdf"), true);
  assert.equal(url.endsWith("#page=3"), true);
  assert.equal(pdfFileUrl("/tmp/vault/report.pdf"), url.slice(0, url.indexOf("#")));
});
