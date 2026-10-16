// Shared ZIP reader for OOXML (.docx now, .pptx / .epub later).
// Central directory only. Stored (0) and deflate (8). ZIP64 and encryption throw.
// Caps are checked before inflate, and inflateRawSync stops at maxOutputLength.

import { inflateRawSync } from "node:zlib";

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

/** Per-entry uncompressed ceiling. Over this, callers treat the package as unreadable. */
export const ZIP_UNCOMPRESSED_CAP = 50 * 1024 * 1024;
/** Entries larger than 1 MB may not expand more than this many times. */
export const ZIP_RATIO_CAP = 100;
export const ZIP_RATIO_MIN_UNCOMPRESSED = 1024 * 1024;

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const ZIP64_LOC_SIG = 0x07064b50;

interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

function need(buf: Buffer, off: number, len: number): void {
  if (off < 0 || len < 0 || off + len > buf.length) throw new ZipError("truncated zip");
}

function u16(buf: Buffer, off: number): number {
  need(buf, off, 2);
  return buf.readUInt16LE(off);
}

function u32(buf: Buffer, off: number): number {
  need(buf, off, 4);
  return buf.readUInt32LE(off);
}

function assertSafe(compressed: number, uncompressed: number): void {
  if (uncompressed > ZIP_UNCOMPRESSED_CAP) throw new ZipError("zip entry exceeds uncompressed cap");
  if (uncompressed > ZIP_RATIO_MIN_UNCOMPRESSED && uncompressed > compressed * ZIP_RATIO_CAP) {
    throw new ZipError("zip entry exceeds compression ratio cap");
  }
}

function findEocd(buf: Buffer): number {
  if (buf.length < 22) throw new ZipError("not a zip");
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (u32(buf, i) !== EOCD_SIG) continue;
    if (i + 22 + u16(buf, i + 20) === buf.length) return i;
  }
  throw new ZipError("not a zip");
}

function listEntries(buf: Buffer): ZipEntry[] {
  const eocd = findEocd(buf);
  if (eocd >= 20 && u32(buf, eocd - 20) === ZIP64_LOC_SIG) throw new ZipError("zip64");
  const entries = u16(buf, eocd + 10);
  const cdSize = u32(buf, eocd + 12);
  const cdOff = u32(buf, eocd + 16);
  if (u16(buf, eocd + 4) === 0xffff || entries === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) {
    throw new ZipError("zip64");
  }
  need(buf, cdOff, cdSize);
  const end = cdOff + cdSize;
  const out: ZipEntry[] = [];
  let pos = cdOff;
  for (let n = 0; n < entries; n++) {
    if (pos + 46 > end || u32(buf, pos) !== CD_SIG) throw new ZipError("truncated zip");
    const flags = u16(buf, pos + 8);
    const method = u16(buf, pos + 10);
    const compressedSize = u32(buf, pos + 20);
    const uncompressedSize = u32(buf, pos + 24);
    const nameLen = u16(buf, pos + 28);
    const extraLen = u16(buf, pos + 30);
    const commentLen = u16(buf, pos + 32);
    const localOffset = u32(buf, pos + 42);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new ZipError("zip64");
    }
    const nameAt = pos + 46;
    need(buf, nameAt, nameLen);
    if (nameAt + nameLen + extraLen + commentLen > end) throw new ZipError("truncated zip");
    out.push({
      name: buf.toString("utf8", nameAt, nameAt + nameLen).replace(/\\/g, "/"),
      method,
      flags,
      compressedSize,
      uncompressedSize,
      localOffset,
    });
    pos = nameAt + nameLen + extraLen + commentLen;
  }
  return out;
}

function inflateEntry(buf: Buffer, entry: ZipEntry): Buffer {
  if (entry.flags & 0x1) throw new ZipError("encrypted zip");
  if (entry.method !== 0 && entry.method !== 8) throw new ZipError("unsupported zip method");
  assertSafe(entry.compressedSize, entry.uncompressedSize);
  if (entry.uncompressedSize === 0) {
    if (entry.compressedSize === 0) return Buffer.alloc(0);
    throw new ZipError("zip entry exceeds uncompressed cap");
  }
  if (u32(buf, entry.localOffset) !== LOCAL_SIG) throw new ZipError("truncated zip");
  const nameLen = u16(buf, entry.localOffset + 26);
  const extraLen = u16(buf, entry.localOffset + 28);
  const start = entry.localOffset + 30 + nameLen + extraLen;
  need(buf, start, entry.compressedSize);
  const compressed = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) {
    if (entry.compressedSize !== entry.uncompressedSize) throw new ZipError("truncated zip");
    return Buffer.from(compressed);
  }
  try {
    return inflateRawSync(compressed, {
      maxOutputLength: Math.min(entry.uncompressedSize, ZIP_UNCOMPRESSED_CAP),
    });
  } catch {
    throw new ZipError("zip entry exceeds uncompressed cap");
  }
}

/** Read one entry by its exact archive name (`word/document.xml`). */
export function readZipEntry(data: Buffer, name: string): Buffer {
  const want = name.replace(/\\/g, "/");
  const entry = listEntries(data).find((item) => item.name === want);
  if (!entry) throw new ZipError(`missing zip entry ${want}`);
  return inflateEntry(data, entry);
}
