/**
 * CSV — the format a programme team actually arrives and leaves with
 * (11, "Bulk import and export").
 *
 * RFC 4180 with the two concessions every real spreadsheet needs: a UTF-8 BOM
 * on output so Excel stops mangling accented names, and tolerance of CRLF and
 * of a trailing newline on input.
 */

export interface ParsedCsv {
  headers: string[];
  /** One entry per data row, in file order. `row_number` is 1-based over data rows. */
  rows: { row_number: number; values: string[] }[];
}

export function parseCsv(source: string): ParsedCsv {
  const text = source.replace(/^﻿/, "");
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      record.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      record.push(field);
      records.push(record);
      field = "";
      record = [];
    } else {
      field += c;
    }
  }
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }

  const nonEmpty = records.filter((r) => r.some((v) => v.trim() !== ""));
  const headers = (nonEmpty.shift() ?? []).map((h) => h.trim());
  return {
    headers,
    rows: nonEmpty.map((values, i) => ({ row_number: i + 1, values })),
  };
}

/** A row as a record keyed by header, with missing trailing cells as "". */
export function rowObject(headers: string[], values: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((h, i) => {
    out[h] = (values[i] ?? "").trim();
  });
  return out;
}

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = Array.isArray(value) ? value.join("; ") : typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const lines = [columns.map(csvCell).join(",")];
  for (const row of rows) lines.push(columns.map((c) => csvCell(row[c])).join(","));
  return "﻿" + lines.join("\r\n") + "\r\n";
}
