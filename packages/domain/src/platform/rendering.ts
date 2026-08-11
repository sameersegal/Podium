/**
 * `{{variable}}` interpolation and the save-time check — 09, "Variables and
 * preview".
 *
 * Two rules, both learned the hard way and both enforced here:
 *   * INV-09-13 — unknown variables fail at save time, not send time.
 *   * Preview resolves against a real named recipient, which is why
 *     `renderTemplate` reports which variables came back empty.
 */

import { DomainError, type FieldError } from "../shared/errors.js";
import { declaredVariables } from "./templates.js";

const TOKEN = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

export function extractVariables(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(TOKEN)) out.add(m[1]);
  return [...out];
}

export interface TemplateValidation {
  ok: boolean;
  unknown: string[];
  declared: readonly string[];
}

export function validateTemplateBody(templateKey: string | null, ...parts: (string | null | undefined)[]): TemplateValidation {
  const declared = declaredVariables(templateKey);
  const used = new Set<string>();
  for (const part of parts) {
    if (!part) continue;
    for (const v of extractVariables(part)) used.add(v);
  }
  const unknown = [...used].filter((v) => !declared.includes(v));
  return { ok: unknown.length === 0, unknown, declared };
}

/**
 * INV-09-13: reject at save time. The error names every unknown variable and
 * lists what was available, because "unknown variable" without the list is a
 * guessing game.
 */
export function assertTemplateBody(templateKey: string | null, subject: string | null, body: string): void {
  const result = validateTemplateBody(templateKey, subject, body);
  if (result.ok) return;
  const fieldErrors: FieldError[] = result.unknown.map((v) => ({
    field_key: "body_markdown",
    message: `{{${v}}} is not a variable of ${templateKey ?? "a composed message"}.`,
  }));
  throw new DomainError({
    code: "unknown_template_variable",
    invariant: "INV-09-13",
    status: 422,
    message: `${result.unknown.map((v) => `{{${v}}}`).join(", ")} ${
      result.unknown.length === 1 ? "is not a variable" : "are not variables"
    } you can use here. Available: ${result.declared.map((v) => `{{${v}}}`).join(", ")}`,
    details: { unknown: result.unknown, declared: [...result.declared] },
    fieldErrors,
  });
}

export interface RenderResult {
  text: string;
  /** Variables that resolved to nothing — the failure a real-recipient preview catches. */
  empty: string[];
}

/**
 * Template variables are addressed with dots — `{{session.title}}` — so the
 * lookup table is flat. Callers naturally build nested objects, and a nested
 * object silently resolving to nothing is how four hundred acceptance emails
 * go out with a blank talk title in them. Flatten before rendering.
 */
export function flattenVariables(input: Record<string, unknown>, prefix = ""): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) {
      Object.assign(out, flattenVariables(value as Record<string, unknown>, path));
    } else {
      out[path] = value;
    }
  }
  return out;
}

export function renderTemplate(body: string, variables: Record<string, unknown>): RenderResult {
  const empty: string[] = [];
  const text = body.replace(TOKEN, (_all, name: string) => {
    const value = variables[name];
    if (value === undefined || value === null || value === "") {
      empty.push(name);
      return "";
    }
    return String(value);
  });
  return { text: tidy(text), empty };
}

/** Collapse the blank lines an empty variable leaves behind. */
function tidy(text: string): string {
  return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** The plain-text half of an email. Markdown is already close enough to read. */
export function toPlainText(markdown: string): string {
  return markdown
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|\W)\*([^*]+)\*/g, "$1$2")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/^>\s?/gm, "")
    .trim();
}
