/** Request body parsing shared by the HTML forms and the JSON API. */

import { validationError } from "@podiumstack/domain/shared/errors.js";

export interface Input {
  get(name: string): string | null;
  str(name: string, fallback?: string): string;
  /**
   * A value that must be one of `allowed`, refused with a field error when it
   * is not. Forms express "unanswered" as the empty string — every required
   * `select` carries an empty first option so that they can — so an unanswered
   * enum arrives here as `""` and is refused by the same check that refuses a
   * misspelled one, rather than being cast into the column.
   */
  member<T extends string>(name: string, allowed: readonly T[], question: string): T;
  optional(name: string): string | null;
  int(name: string, fallback?: number | null): number | null;
  bool(name: string): boolean;
  list(name: string): string[];
  json<T>(name: string, fallback: T): T;
  all(): Record<string, unknown>;
  files(name: string): File[];
  has(name: string): boolean;
}

export async function readInput(req: Request): Promise<Input> {
  const contentType = req.headers.get("content-type") ?? "";
  let values: Record<string, unknown> = {};
  let form: FormData | null = null;

  if (contentType.includes("application/json")) {
    try {
      values = (await req.json()) as Record<string, unknown>;
    } catch {
      values = {};
    }
  } else if (contentType.includes("form")) {
    form = await req.formData();
    for (const key of new Set(form.keys())) {
      const all = form.getAll(key);
      values[key] = all.length > 1 ? all.map(String) : typeof all[0] === "string" ? all[0] : all[0];
    }
  }

  const get = (name: string): string | null => {
    const v = values[name];
    if (v === undefined || v === null) return null;
    if (Array.isArray(v)) return v.length ? String(v[0]) : null;
    if (typeof v === "object") return null;
    return String(v);
  };

  return {
    get,
    has: (name) => values[name] !== undefined,
    str: (name, fallback = "") => (get(name) ?? fallback).trim(),
    member: (name, allowed, question) => {
      const v = (get(name) ?? "").trim();
      if ((allowed as readonly string[]).includes(v)) return v as typeof allowed[number];
      throw validationError(`${question}`, [{ field_key: name, message: question }]);
    },
    optional: (name) => {
      const v = get(name);
      return v === null || v.trim() === "" ? null : v.trim();
    },
    int: (name, fallback = null) => {
      const v = get(name);
      if (v === null || v.trim() === "") return fallback;
      const n = Number(v);
      return Number.isFinite(n) ? Math.round(n) : fallback;
    },
    bool: (name) => {
      const v = get(name);
      return v === "1" || v === "true" || v === "on" || v === "yes";
    },
    list: (name) => {
      const v = values[name];
      if (v === undefined || v === null) return [];
      if (Array.isArray(v)) return v.map(String).filter((s) => s !== "");
      const s = String(v);
      return s === "" ? [] : [s];
    },
    json: <T,>(name: string, fallback: T): T => {
      const v = values[name];
      if (v === undefined || v === null) return fallback;
      if (typeof v === "object") return v as T;
      try {
        return JSON.parse(String(v)) as T;
      } catch {
        return fallback;
      }
    },
    all: () => ({ ...values }),
    files: (name) => {
      if (!form) return [];
      return form.getAll(name).filter((f): f is File => typeof f !== "string");
    },
  };
}

/** Field names prefixed `answer.` become `ProposalAnswer` rows. */
export function collectPrefixed(input: Input, prefix: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input.all())) {
    if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
  }
  return out;
}
