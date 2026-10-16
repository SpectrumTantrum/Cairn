// In-test ZIP builder. Fixtures stay XML strings; nothing binary is committed.
import { deflateRawSync } from "node:zlib";

/** @param {{ name: string, data: Buffer | string, method?: number, flags?: number, uncompressedSize?: number }[]} entries */
export function zipEntries(entries) {
  const locals = [];
  const cds = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data));
    const method = entry.method ?? 0;
    const compressed = method === 8 ? deflateRawSync(raw) : raw;
    const flags = entry.flags ?? 0;
    const uncompressedSize = entry.uncompressedSize ?? raw.length;
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    const blob = Buffer.concat([local, compressed]);
    const cd = Buffer.alloc(46 + name.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(flags, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(compressed.length, 20);
    cd.writeUInt32LE(uncompressedSize, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    name.copy(cd, 46);
    locals.push(blob);
    cds.push(cd);
    offset += blob.length;
  }
  const cdBuf = Buffer.concat(cds);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

/** A .docx package with word/document.xml and an optional word/styles.xml. */
export function docxBuffer(documentXml, stylesXml) {
  const entries = [{ name: "word/document.xml", data: documentXml }];
  if (stylesXml) entries.push({ name: "word/styles.xml", data: stylesXml });
  return zipEntries(entries);
}
