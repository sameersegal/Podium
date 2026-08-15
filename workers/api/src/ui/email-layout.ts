/**
 * Transactional email layout — ports `docs/design/emails/` into send-ready
 * markup. See that directory's `README.md` for the visual spec; the
 * "Email-client constraints" section there is why this file looks the way it
 * does (nested `role="presentation"` tables, every style inlined, no images,
 * no web fonts, bulletproof buttons, a hidden preheader, `mso-line-height-rule`
 * on every text cell, `color-scheme` meta).
 *
 * **Conference-first branding** (12-glossary.md, "Speaker-facing email is
 * sent as the event, not as the product"): the event or organization owns the
 * header and the voice; Podium is a one-line, muted footer credit and
 * nothing else. That is true for every `TemplateAudience` — internal
 * (organizers, reviewers) and external (speakers, sponsors) share this exact
 * shell, only the header label and footer permission-reason change.
 *
 * `docs/design/emails/*.html` are the three high-fidelity references this
 * was ported from — their eyebrow, stat strip, detail card and closing panel
 * are per-email content that a fixed sample wrote by hand. A `NotificationTemplate`
 * body is arbitrary, organizer-editable Markdown, so what is ported here is
 * the *shell and typographic system* those three files share, applied to
 * whatever blocks the body actually contains.
 */

import { escapeHtml } from "./html.js";
import type { TemplateAudience } from "@podiumstack/domain/platform/templates.js";

/* -------------------------------------------------------------------------- */
/* Design tokens — docs/design/emails/README.md, "Design tokens"              */
/* -------------------------------------------------------------------------- */

const CANVAS = "#efedea";
const CARD = "#fbfaf8";
const PANEL = "#f2f4f6";
const BORDER = "#e3e1de";
const INK = "#1c1b1a";
const BODY_COLOR = "#46433f";
const MUTED = "#8a8681";
const MUTED_LIGHT = "#a5a19c";
const FONT = "Helvetica,Arial,sans-serif";

/**
 * "The accent `#2a6f97` is the only brand-owned color... Making it a
 * per-conference token is enough to rebrand the set." Per-event/org override
 * lives at `settings.branding.email_accent` (01, `Organization.settings`;
 * 02, `Event.settings` — "overrides of org settings, same keys").
 */
export const DEFAULT_EMAIL_ACCENT = "#2a6f97";

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** Reads `settings.branding.email_accent`, ignoring anything not a hex color. */
function brandingAccent(settings: Record<string, unknown> | null | undefined): string | null {
  if (!settings) return null;
  const branding = settings.branding;
  if (!branding || typeof branding !== "object") return null;
  const v = (branding as Record<string, unknown>).email_accent;
  return typeof v === "string" && HEX_COLOR.test(v) ? v : null;
}

/**
 * Event settings override org settings, same keys (02, `Event.settings`).
 * Falls back to `DEFAULT_EMAIL_ACCENT` when neither sets a valid hex color.
 */
export function resolveEmailAccent(
  eventSettings: Record<string, unknown> | null | undefined,
  orgSettings: Record<string, unknown> | null | undefined,
): string {
  return brandingAccent(eventSettings) ?? brandingAccent(orgSettings) ?? DEFAULT_EMAIL_ACCENT;
}

/* -------------------------------------------------------------------------- */
/* Audience — header label and footer permission reason                       */
/* -------------------------------------------------------------------------- */

/** 09, "Notifications": the header's right-hand label, per audience. */
export const AUDIENCE_LABEL: Record<TemplateAudience, string> = {
  organizers: "Program Team",
  reviewers: "Program Committee",
  speakers: "Speakers",
  sponsors: "Sponsors",
};

/** The footer's "you're receiving this because..." line, per audience. */
export function permissionReasonFor(audience: TemplateAudience, eventOrOrgName: string): string {
  const name = eventOrOrgName || "this organization";
  switch (audience) {
    case "reviewers":
      return `You are receiving this because you serve on the program committee for ${name}.`;
    case "organizers":
      return `You are receiving this because you are on the program team for ${name}.`;
    case "sponsors":
      return `You are receiving this because your organization sponsors ${name}.`;
    case "speakers":
    default:
      return `You are receiving this because you submitted a proposal to ${name}.`;
  }
}

/* -------------------------------------------------------------------------- */
/* Preheader — README: "First element in <body> is a hidden preheader span    */
/* (~85 chars) that previews next to the subject line."                       */
/* -------------------------------------------------------------------------- */

/** The first non-blank line of the plain-text body, trimmed to `max` characters. */
export function deriveEmailPreheader(plainTextBody: string, max = 85): string {
  const firstLine = (plainTextBody ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  const text = firstLine ?? "";
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/* -------------------------------------------------------------------------- */
/* Body — Markdown blocks, styled with the design system's typographic scale  */
/* -------------------------------------------------------------------------- */

type Block =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; items: string[] }
  | { type: "blockquote"; lines: string[] }
  | { type: "button"; href: string; label: string };

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const LIST_ITEM_RE = /^[-*]\s+/;
const QUOTE_RE = /^>\s?/;

/** Same block set `ui/html.ts`'s `markdown()` recognises, plus blockquotes —
 * needed here because `proposal.changes_requested`'s default body already
 * uses `> {{decision.note}}` (09, `templates.ts`).
 *
 * Standard markdown paragraph semantics: consecutive plain-text lines with no
 * blank line between them are one hard-wrapped paragraph, joined with a
 * single space, not one row per source line — a template body wrapped for a
 * source-file line length ("...before\nthe slot is released...") must not
 * render with a gap mid-sentence. The buffer flushes on a blank line, a
 * heading, a list item or a quote line, same as every other block. This is
 * also why a lone URL merges into surrounding prose rather than promoting to
 * a button when there is no blank line isolating it — a real paragraph break
 * is what "lone" means. */
function parseBlocks(src: string): Block[] {
  const lines = String(src ?? "").split(/\r?\n/);
  const blocks: Block[] = [];
  let listBuf: string[] = [];
  let quoteBuf: string[] = [];
  let paraBuf: string[] = [];
  const flushList = () => {
    if (listBuf.length) {
      blocks.push({ type: "list", items: listBuf });
      listBuf = [];
    }
  };
  const flushQuote = () => {
    if (quoteBuf.length) {
      blocks.push({ type: "blockquote", lines: quoteBuf });
      quoteBuf = [];
    }
  };
  const flushPara = () => {
    if (paraBuf.length) {
      blocks.push({ type: "paragraph", text: paraBuf.join(" ") });
      paraBuf = [];
    }
  };
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) {
      flushList();
      flushQuote();
      flushPara();
      continue;
    }
    const heading = HEADING_RE.exec(t);
    if (heading) {
      flushList();
      flushQuote();
      flushPara();
      blocks.push({ type: "heading", level: Math.min(heading[1].length, 6), text: heading[2] });
      continue;
    }
    if (LIST_ITEM_RE.test(t)) {
      flushQuote();
      flushPara();
      listBuf.push(t.replace(LIST_ITEM_RE, ""));
      continue;
    }
    if (QUOTE_RE.test(t)) {
      flushList();
      flushPara();
      quoteBuf.push(t.replace(QUOTE_RE, ""));
      continue;
    }
    flushList();
    flushQuote();
    paraBuf.push(t);
  }
  flushList();
  flushQuote();
  flushPara();
  return blocks;
}

const BARE_URL_RE = /^(https?:\/\/\S+)$/;
const LONE_MD_LINK_RE = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/;

/**
 * "A paragraph consisting solely of a link (or a bare URL — today's default
 * templates use bare URLs on their own line) renders as the bulletproof CTA
 * button in the accent color; subsequent lone links stay as text links."
 * Only the first eligible paragraph in the body is promoted.
 */
function promoteLoneLinkToButton(blocks: Block[]): Block[] {
  let used = false;
  return blocks.map((b) => {
    if (used || b.type !== "paragraph") return b;
    const bare = BARE_URL_RE.exec(b.text);
    if (bare) {
      used = true;
      return { type: "button", href: bare[1], label: bare[1] } satisfies Block;
    }
    const link = LONE_MD_LINK_RE.exec(b.text);
    if (link) {
      used = true;
      return { type: "button", href: link[2], label: link[1] } satisfies Block;
    }
    return b;
  });
}

// Markdown link syntax, or a bare URL — the latter is what a lone-link
// paragraph that missed button promotion (a second one in the same body) and
// every mid-sentence `{{variable}}` URL in the shipped default templates
// ("Full schedule: {{schedule_url}}") actually is. Alternation tries the
// markdown-link branch first at each position, so `[label](url)` is never
// double-matched by the bare-URL branch.
const COMBINED_LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/\S+)/g;
const TRAILING_PUNCT_RE = /[.,;:!?)\]}"'’”]+$/;
const BOLD_RE = /\*\*([^*]+)\*\*/g;
const ITALIC_RE = /(^|\W)\*([^*]+)\*/g;
const CODE_RE = /`([^`]+)`/g;

function linkHtml(href: string, label: string, accent: string): string {
  return `<a href="${escapeHtml(href)}" style="color:${accent}; text-decoration:underline;">${escapeHtml(label)}</a>`;
}

/**
 * Links first, over the *raw* text — so a trailing `.` or `)` in "See
 * https://example.com/x." is not swept into the href — then escape every
 * literal segment in between. Bold, italic and code apply afterward, to the
 * fully-escaped-and-linked string, same order `ui/html.ts`'s `markdown()`
 * uses. "All interpolated user content must remain HTML-escaped": every
 * character that is not part of a recognised link, bold, italic or code span
 * passes through `escapeHtml`.
 */
function inline(text: string, accent: string): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(COMBINED_LINK_RE)) {
    out += escapeHtml(text.slice(last, m.index));
    if (m[1] !== undefined) {
      out += linkHtml(m[2], m[1], accent); // [label](url)
    } else {
      let url = m[3];
      let trail = "";
      const trailMatch = TRAILING_PUNCT_RE.exec(url);
      if (trailMatch && url.length - trailMatch[0].length > "https://".length) {
        trail = trailMatch[0];
        url = url.slice(0, url.length - trail.length);
      }
      out += linkHtml(url, url, accent) + escapeHtml(trail);
    }
    last = m.index + m[0].length;
  }
  out += escapeHtml(text.slice(last));

  out = out.replace(BOLD_RE, `<strong style="color:${INK};">$1</strong>`);
  out = out.replace(ITALIC_RE, `$1<em style="color:${INK};">$2</em>`);
  out = out.replace(CODE_RE, `<code style="font-family:'Courier New',Courier,monospace; font-size:14px; background-color:${PANEL}; padding:2px 4px; border-radius:3px;">$1</code>`);
  return out;
}

function row(top: number, bottom: number, inner: string): string {
  return `<tr><td class="px" style="padding:${top}px 40px ${bottom}px 40px;">${inner}</td></tr>`;
}

/** Sizes for `##`…`######`; a level-1 heading gets the design's own H1 token, below. */
const HEADING_SIZES: Record<number, [number, number]> = {
  2: [21, 27],
  3: [19, 25],
  4: [17, 23],
  5: [16, 22],
  6: [15, 21],
};

function headingHtml(text: string, level: number, accent: string): string {
  if (level === 1) {
    // README, "Design tokens": H1 is 32/38 desktop, 28/34 mobile, -0.6px
    // tracking — the one heading size with its own responsive rule, so it is
    // the one that carries the `.h1` class hook the stylesheet declares.
    return `<h1 class="h1" style="margin:0; font-family:${FONT}; font-size:32px; line-height:38px; mso-line-height-rule:exactly; font-weight:bold; color:${INK}; letter-spacing:-0.6px;">${inline(text, accent)}</h1>`;
  }
  const [size, lh] = HEADING_SIZES[level] ?? HEADING_SIZES[6];
  return `<div style="font-family:${FONT}; font-size:${size}px; line-height:${lh}px; mso-line-height-rule:exactly; font-weight:bold; color:${INK}; letter-spacing:-0.3px;">${inline(text, accent)}</div>`;
}

function paragraphHtml(text: string, accent: string): string {
  return `<div style="font-family:${FONT}; font-size:16px; line-height:26px; mso-line-height-rule:exactly; color:${BODY_COLOR};">${inline(text, accent)}</div>`;
}

function listHtml(items: string[], accent: string): string {
  const lis = items
    .map((it) => `<li style="padding-bottom:8px; font-family:${FONT}; font-size:15px; line-height:22px; mso-line-height-rule:exactly; color:${BODY_COLOR};">${inline(it, accent)}</li>`)
    .join("");
  return `<ul style="margin:0; padding:0 0 0 20px;">${lis}</ul>`;
}

function blockquoteHtml(lines: string[], accent: string): string {
  const inner = lines
    .map((l) => `<div style="font-family:${FONT}; font-size:15px; line-height:24px; mso-line-height-rule:exactly; color:${BODY_COLOR};">${inline(l, accent)}</div>`)
    .join("");
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td style="border-left:3px solid ${BORDER}; padding:2px 0 2px 16px;">${inner}</td></tr></table>`;
}

/** README, "CTA button" — bulletproof: a padded `<td bgcolor>`, never a `<button>` or `<img>`. */
function buttonHtml(href: string, label: string, accent: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${accent}" style="border-radius:4px;"><a href="${escapeHtml(href)}" style="display:block; padding:15px 30px; font-family:${FONT}; font-size:15px; line-height:20px; mso-line-height-rule:exactly; font-weight:bold; color:#ffffff; text-decoration:none; border-radius:4px;">${escapeHtml(label)}</a></td></tr></table>`;
}

function topPaddingFor(type: Block["type"]): number {
  switch (type) {
    case "heading":
      return 28;
    case "list":
    case "blockquote":
      return 24;
    case "button":
      return 28;
    case "paragraph":
    default:
      return 20;
  }
}

/** Renders a template body's markdown into the styled, table-row content of the card. */
export function renderEmailBody(bodyMarkdown: string, accent: string): string {
  const blocks = promoteLoneLinkToButton(parseBlocks(bodyMarkdown));
  if (blocks.length === 0) {
    return row(32, 40, paragraphHtml("", accent));
  }
  return blocks
    .map((b, i) => {
      const first = i === 0;
      const last = i === blocks.length - 1;
      const top = first ? 32 : topPaddingFor(b.type);
      const bottom = last ? 40 : 0;
      switch (b.type) {
        case "heading":
          return row(top, bottom, headingHtml(b.text, b.level, accent));
        case "paragraph":
          return row(top, bottom, paragraphHtml(b.text, accent));
        case "list":
          return row(top, bottom, listHtml(b.items, accent));
        case "blockquote":
          return row(top, bottom, blockquoteHtml(b.lines, accent));
        case "button":
          return row(top, bottom, buttonHtml(b.href, b.label, accent));
      }
    })
    .join("");
}

/* -------------------------------------------------------------------------- */
/* The layout — page canvas, card, header row, body, footer                   */
/* -------------------------------------------------------------------------- */

export interface EmailLayoutInput {
  /** Header left. Falls back to `orgName` when there is no event (`README`: "left: event name — fall back to org name when there is no event"). */
  eventName: string | null;
  orgName: string;
  audienceLabel: string;
  bodyMarkdown: string;
  /** Plain-text rendering of the same body, used only to derive the preheader. */
  plainTextBody: string;
  /** Hex color; anything else falls back to `DEFAULT_EMAIL_ACCENT`. */
  accent?: string | null;
  permissionReason: string;
  /** Omitted from the footer when there is no preferences surface to point at. */
  preferencesUrl?: string | null;
  /**
   * Omitted from the footer — the whole link, not just left blank — on a
   * transactional send: INV-09-10 makes the link inoperative there, so
   * showing it would be a control that cannot work. Non-transactional sends
   * (campaigns) always carry it. See callers in `notifications.ts`, which
   * derive this from the same `transactional` boolean the suppression check
   * uses, so the two can never disagree.
   */
  unsubscribeUrl?: string | null;
  /**
   * `Organization.postal_address` (01) — its own muted line, above the
   * Podium credit (docs/design/emails/README.md, "Shared structure" item
   * 11). Omitted entirely, not rendered blank, when the org has none.
   */
  postalAddress?: string | null;
}

/**
 * The single `<style>` block this system ever ships — the 620px responsive
 * breakpoint (README, "Responsive"). `.stat` is deliberately absent: this
 * port carries the shell and typographic system, not the sample layouts'
 * stat-strip content, so no element ever carries that class.
 */
const RESPONSIVE_STYLE = `@media only screen and (max-width: 620px) { .container { width: 100% !important; } .px { padding-left: 24px !important; padding-right: 24px !important; } .h1 { font-size: 28px !important; line-height: 34px !important; } }`;

/** Collapses a free-typed, possibly multi-line address into one visual footer line. */
function formatPostalAddressLine(address: string | null | undefined): string {
  return (address ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(", ");
}

export function renderEmailLayout(input: EmailLayoutInput): string {
  const accent = input.accent && HEX_COLOR.test(input.accent) ? input.accent : DEFAULT_EMAIL_ACCENT;
  const headerName = (input.eventName?.trim() || input.orgName || "").trim();
  const preheader = deriveEmailPreheader(input.plainTextBody);
  const bodyRows = renderEmailBody(input.bodyMarkdown, accent);

  // "Email preferences · Unsubscribe" — either, both or neither, never a
  // dangling separator when one side is absent.
  const footerLinks: string[] = [];
  if (input.preferencesUrl) {
    footerLinks.push(`<a href="${escapeHtml(input.preferencesUrl)}" style="color:${accent}; text-decoration:underline;">Email preferences</a>`);
  }
  if (input.unsubscribeUrl) {
    footerLinks.push(`<a href="${escapeHtml(input.unsubscribeUrl)}" style="color:${accent}; text-decoration:underline;">Unsubscribe</a>`);
  }
  const footerLinksLine = footerLinks.length ? `${footerLinks.join("&nbsp;&middot;&nbsp;")}<br>` : "";

  const addressText = formatPostalAddressLine(input.postalAddress);
  const addressLine = addressText ? `<span style="color:${MUTED_LIGHT};">${escapeHtml(addressText)}</span><br>` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<style>${RESPONSIVE_STYLE}</style>
</head>
<body style="margin:0; padding:0; background-color:${CANVAS}; -webkit-font-smoothing:antialiased;">
<span style="display:none; visibility:hidden; opacity:0; color:transparent; height:0; width:0; overflow:hidden; mso-hide:all;">${escapeHtml(preheader)}</span>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:${CANVAS};">
<tr>
<td align="center" style="padding:32px 12px 48px 12px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" class="container" style="width:600px; max-width:600px; background-color:${CARD}; border:1px solid ${BORDER}; border-radius:4px;">
<tr>
<td class="px" style="padding:28px 40px 26px 40px; border-bottom:1px solid ${BORDER};">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
<tr>
<td align="left" style="font-family:${FONT}; font-size:16px; line-height:20px; mso-line-height-rule:exactly; font-weight:bold; color:${INK}; letter-spacing:-0.2px;">${escapeHtml(headerName)}</td>
<td align="right" style="font-family:${FONT}; font-size:11px; line-height:20px; mso-line-height-rule:exactly; color:${MUTED}; letter-spacing:0.6px; text-transform:uppercase;">${escapeHtml(input.audienceLabel)}</td>
</tr>
</table>
</td>
</tr>
${bodyRows}
</table>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" class="container" style="width:600px; max-width:600px;">
<tr>
<td class="px" align="center" style="padding:24px 40px 0 40px; font-family:${FONT}; font-size:12px; line-height:20px; mso-line-height-rule:exactly; color:${MUTED};">
${escapeHtml(input.permissionReason)}<br>
${footerLinksLine}${addressLine}<span style="color:${MUTED_LIGHT};">Program run on Podium</span>
</td>
</tr>
</table>
</td>
</tr>
</table>
</body>
</html>`;
}
