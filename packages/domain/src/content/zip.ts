/**
 * A minimal store-only ZIP writer — 11, "Bulk import and export".
 *
 * `zip` exports of `files` are "latest versions only, grouped one folder per
 * session, which is what an AV team asks for". That needs no compression and no
 * dependency: an AV team's 200 slide decks are already PDFs and Keynotes, which
 * compress by single digits, and DEFLATE in a Worker would cost CPU for
 * nothing. Store-only (method 0) is a format every unzip program has read since
 * 1989.
 *
 * Zip64 is deliberately not implemented; the writer refuses an archive it could
 * not describe rather than emitting one that silently truncates.
 */

export interface ZipEntry {
  /** Path inside the archive, `/`-separated. Directories are implied. */
  path: string;
  data: Uint8Array;
  /** Defaults to now; stored as an MS-DOS timestamp. */
  modified?: Date;
}

const MAX_ZIP_BYTES = 0xffffffff;

export class ZipTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(`This archive would be ${bytes} bytes, past the 4 GB limit of a non-Zip64 archive.`);
    this.name = "ZipTooLargeError";
  }
}

export function createZip(entries: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  let total = 0;

  const seen = new Set<string>();
  for (const entry of entries) {
    const path = uniquePath(normalisePath(entry.path), seen);
    const name = encoder.encode(path);
    const crc = crc32(entry.data);
    const { time, date } = dosTime(entry.modified ?? new Date());

    const header = new Uint8Array(30 + name.length);
    const hv = new DataView(header.buffer);
    hv.setUint32(0, 0x04034b50, true); // local file header
    hv.setUint16(4, 20, true); // version needed
    hv.setUint16(6, 0x0800, true); // UTF-8 filename flag
    hv.setUint16(8, 0, true); // method 0 — stored
    hv.setUint16(10, time, true);
    hv.setUint16(12, date, true);
    hv.setUint32(14, crc, true);
    hv.setUint32(18, entry.data.length, true);
    hv.setUint32(22, entry.data.length, true);
    hv.setUint16(26, name.length, true);
    hv.setUint16(28, 0, true);
    header.set(name, 30);

    local.push(header, entry.data);

    const dir = new Uint8Array(46 + name.length);
    const dv = new DataView(dir.buffer);
    dv.setUint32(0, 0x02014b50, true); // central directory header
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 20, true);
    dv.setUint16(8, 0x0800, true);
    dv.setUint16(10, 0, true);
    dv.setUint16(12, time, true);
    dv.setUint16(14, date, true);
    dv.setUint32(16, crc, true);
    dv.setUint32(20, entry.data.length, true);
    dv.setUint32(24, entry.data.length, true);
    dv.setUint16(28, name.length, true);
    dv.setUint32(42, offset, true);
    dir.set(name, 46);
    central.push(dir);

    offset += header.length + entry.data.length;
    total += header.length + entry.data.length + dir.length;
    if (total > MAX_ZIP_BYTES) throw new ZipTooLargeError(total);
  }

  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); // end of central directory
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  return concat([...local, ...central, end]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** No leading slash, no `..`, no backslashes — an archive is not a path traversal. */
export function normalisePath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .split("/")
    .filter((s) => s !== "" && s !== "." && s !== "..")
    .join("/");
}

function uniquePath(path: string, seen: Set<string>): string {
  if (!seen.has(path)) {
    seen.add(path);
    return path;
  }
  const dot = path.lastIndexOf(".");
  const stem = dot > 0 ? path.slice(0, dot) : path;
  const ext = dot > 0 ? path.slice(dot) : "";
  for (let i = 2; ; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!seen.has(candidate)) {
      seen.add(candidate);
      return candidate;
    }
  }
}

function dosTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getUTCFullYear());
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

let CRC_TABLE: Uint32Array | null = null;

function crcTable(): Uint32Array {
  if (CRC_TABLE) return CRC_TABLE;
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  CRC_TABLE = table;
  return table;
}

export function crc32(data: Uint8Array): number {
  const table = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = table[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
