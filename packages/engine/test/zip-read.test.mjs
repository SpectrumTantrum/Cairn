// ZIP reader fuzz: truncated, garbage, ZIP64, encryption, and fake expansion.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { zipEntries } from "./docx-zip.mjs";

let readZipEntry;
let ZipError;
let ZIP_UNCOMPRESSED_CAP;
let ZIP_RATIO_MIN_UNCOMPRESSED;

before(async () => {
  const engine = await import("../dist/index.js");
  readZipEntry = engine.readZipEntry;
  ZipError = engine.ZipError;
  ZIP_UNCOMPRESSED_CAP = engine.ZIP_UNCOMPRESSED_CAP;
  ZIP_RATIO_MIN_UNCOMPRESSED = engine.ZIP_RATIO_MIN_UNCOMPRESSED;
});

function read(buf, name = "word/document.xml") {
  return readZipEntry(buf, name);
}

test("stored and deflate entries round-trip", () => {
  const stored = zipEntries([{ name: "word/document.xml", data: "hello stored" }]);
  assert.equal(read(stored).toString("utf8"), "hello stored");
  const deflated = zipEntries([{ name: "word/document.xml", data: "hello deflate", method: 8 }]);
  assert.equal(read(deflated).toString("utf8"), "hello deflate");
});

test("truncated and garbage zips throw", () => {
  assert.throws(() => read(Buffer.from("PK")), ZipError);
  assert.throws(() => read(Buffer.alloc(80, 7)), ZipError);
  const whole = zipEntries([{ name: "word/document.xml", data: "abcdefghij" }]);
  assert.throws(() => read(whole.subarray(0, Math.floor(whole.length / 2))), ZipError);
});

test("zip64 and encryption throw", () => {
  const zip64 = zipEntries([{ name: "word/document.xml", data: "x" }]);
  zip64.writeUInt32LE(0xffffffff, zip64.length - 6);
  assert.throws(() => read(zip64), /zip64/);
  const encrypted = zipEntries([{ name: "word/document.xml", data: "secret", flags: 1 }]);
  assert.throws(() => read(encrypted), /encrypted/);
  const odd = zipEntries([{ name: "word/document.xml", data: "x", method: 12, uncompressedSize: 1 }]);
  assert.throws(() => read(odd), /unsupported zip method/);
});

test("a huge declared size is rejected before inflate", () => {
  const overCap = zipEntries([
    {
      name: "word/document.xml",
      data: "tiny",
      uncompressedSize: ZIP_UNCOMPRESSED_CAP + 1,
    },
  ]);
  assert.throws(() => read(overCap), /uncompressed cap/);
  const ratio = zipEntries([
    {
      name: "word/document.xml",
      data: "tiny",
      method: 8,
      uncompressedSize: ZIP_RATIO_MIN_UNCOMPRESSED + 50_000,
    },
  ]);
  assert.throws(() => read(ratio), /compression ratio/);
});

test("inflate stops at the declared size instead of expanding", () => {
  const bomb = zipEntries([
    {
      name: "word/document.xml",
      data: "A".repeat(4000),
      method: 8,
      uncompressedSize: 32,
    },
  ]);
  assert.throws(() => read(bomb), /uncompressed cap/);
});
