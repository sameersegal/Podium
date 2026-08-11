/**
 * A tiny server-rendered HTML kit. No build step, no client framework — the
 * public surfaces have to work with scripts blocked (08, "Degrade gracefully")
 * and the admin surfaces are forms.
 */

export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

export function raw(value: string): SafeHtml {
  return new SafeHtml(value);
}

export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function render(part: unknown): string {
  if (part === null || part === undefined || part === false) return "";
  if (part instanceof SafeHtml) return part.value;
  if (Array.isArray(part)) return part.map(render).join("");
  return escapeHtml(part);
}

export function html(strings: TemplateStringsArray, ...parts: unknown[]): SafeHtml {
  let out = strings[0];
  for (let i = 0; i < parts.length; i++) out += render(parts[i]) + strings[i + 1];
  return new SafeHtml(out);
}

/** Attribute-safe JSON, for embedding a payload in a data attribute or script. */
export function jsonScript(id: string, data: unknown): SafeHtml {
  const body = JSON.stringify(data).replace(/</g, "\\u003c");
  return raw(`<script type="application/json" id="${escapeHtml(id)}">${body}</script>`);
}

/**
 * A very small Markdown subset — headings, bold, italics, links, lists,
 * paragraphs. `bio` and `intro_markdown` are the fields that use it.
 */
export function markdown(src: string | null | undefined): SafeHtml {
  if (!src) return raw("");
  const lines = String(src).split(/\r?\n/);
  const out: string[] = [];
  let inList = false;
  const inline = (s: string) =>
    escapeHtml(s)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|\W)\*([^*]+)\*/g, "$1<em>$2</em>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" rel="noopener">$1</a>');
  for (const line of lines) {
    const t = line.trim();
    if (!t) {
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(t);
    if (heading) {
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
      const level = Math.min(heading[1].length + 1, 6);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    if (/^[-*]\s+/.test(t)) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${inline(t.replace(/^[-*]\s+/, ""))}</li>`);
      continue;
    }
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
    out.push(`<p>${inline(t)}</p>`);
  }
  if (inList) out.push("</ul>");
  return raw(out.join(""));
}

export function joinHtml(parts: unknown[], separator = ""): SafeHtml {
  return raw(parts.map(render).join(separator));
}
