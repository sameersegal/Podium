/**
 * The console's component vocabulary.
 *
 * These are the same components `workers/api/src/ui/layout.ts` renders on the
 * server, against the same class names, because R30 chose one stylesheet —
 * `public/admin.css` — as the shared artifact rather than a component library
 * imported twice. A screen that is half-ported therefore looks like one
 * product: the server's `card` and this `card` are the same card.
 *
 * Anything genuinely new to the console — the drawer, the toast stack, the
 * drag affordances, the dashboard's charts — is styled in `public/console.css`,
 * which loads after `admin.css` and adds rather than overrides.
 */

import { h, cx } from "./kit.js";

/* -------------------------------------------------------------------------- */
/* Text                                                                        */
/* -------------------------------------------------------------------------- */

export function humanise(value) {
  if (!value) return "";
  const s = String(value).replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function pluralise(n, one, many) {
  return n === 1 ? one : many || one + "s";
}

/** `1 thing` / `2 things` — the count and the word, where callers want both. */
export function plural(n, one, many) {
  return n + " " + pluralise(n, one, many);
}

const WORDS = [
  "Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen", "Twenty",
];

/**
 * Small numbers, spelled, for the start of a sentence — the mirror of
 * `workers/api/src/ui/words.ts`, so the console and the server-rendered screen
 * that share a URL also share their headings.
 *
 * Only ever in prose. Every *value* on these screens stays a numeral in the
 * mono face, because those are read by comparison.
 */
export function spell(n) {
  return Number.isInteger(n) && n >= 0 && n <= 20 ? WORDS[n] : String(n);
}

/** Calendar dates are never converted to a zone (11, "Time"). */
export function formatDate(iso) {
  if (!iso) return "—";
  const date = iso.length === 10 ? iso + "T00:00:00Z" : iso;
  const d = new Date(date);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

export function formatDateTime(iso, timezone) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: timezone || undefined,
  });
}

/** "in 6 days" / "3 days ago" — a deadline is read as distance, not as a date. */
export function relativeDays(iso, now) {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (isNaN(then)) return null;
  const days = Math.round((then - (now || Date.now())) / 86400000);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  return days > 0 ? "in " + days + " days" : Math.abs(days) + " days ago";
}

/* -------------------------------------------------------------------------- */
/* Primitives                                                                  */
/* -------------------------------------------------------------------------- */

export function card(body, title, options) {
  const o = options || {};
  return h(
    "section",
    { class: cx("card", o.class), key: o.key },
    title ? h("div", { class: "head" }, h("h2", null, title), o.actions || null) : null,
    body,
  );
}

export function badge(value, tone) {
  return h("span", { class: cx("badge", tone || toneFor(value)) }, humanise(value));
}

function toneFor(value) {
  const v = String(value || "");
  if (["active", "open", "published", "live", "confirmed", "accepted", "completed", "approved"].includes(v)) return "ok";
  if (["draft", "pending", "scheduled", "in_review", "submitted", "tentative"].includes(v)) return "info";
  if (["closed", "changes_requested", "waitlisted", "blocked", "at_risk"].includes(v)) return "warn";
  if (["archived", "rejected", "cancelled", "withdrawn", "failed", "overdue"].includes(v)) return "err";
  return "";
}

export function empty(message, action) {
  return h("div", { class: "empty" }, h("p", null, message), action || null);
}

export function pageHead(title, lede, actions) {
  return h(
    "div",
    { class: "page-head" },
    h("div", { class: "grow" }, h("h1", null, title), lede ? h("p", { class: "lede" }, lede) : null),
    actions ? h("div", { class: "actions" }, actions) : null,
  );
}

export function button(label, onclick, options) {
  const o = options || {};
  return h(
    "button",
    {
      type: "button",
      class: cx(o.variant || "", o.size === "small" ? "small" : "", o.class),
      onclick,
      disabled: o.disabled || false,
      title: o.title || null,
      "aria-label": o.ariaLabel || null,
    },
    o.busy ? spinner() : null,
    label,
  );
}

export function spinner() {
  return h("span", { class: "console-spinner", "aria-hidden": "true" });
}

/** The same bar `layout.ts::progressBar` draws, against the same `.progress`. */
export function progressBar(percent) {
  const pct = Math.max(0, Math.min(100, Math.round(percent)));
  return h("div", { class: "progress", title: pct + "%" }, h("span", { style: "width:" + pct + "%" }));
}

export function notice(message, kind) {
  return message ? h("p", { class: cx("notice", kind || "") }, message) : null;
}

/**
 * A stat that is also a link. Every number on an admin dashboard has a screen
 * where the thing it counts can be done; one that does not is a number the
 * reader has to translate into an action by hand.
 */
export function stat(label, value, href, options) {
  const o = options || {};
  const inner = [
    h("span", { class: "n" }, value == null ? "—" : String(value)),
    h("span", { class: "l" }, label),
    o.hint ? h("span", { class: "console-stat-hint" }, o.hint) : null,
  ];
  return href
    ? h("a", { class: cx("stat", o.tone && "console-stat-" + o.tone), href, key: o.key || label }, inner)
    : h("div", { class: cx("stat", o.tone && "console-stat-" + o.tone), key: o.key || label }, inner);
}

export function stats(children) {
  return h("div", { class: "stats" }, children);
}

export function table(headers, rows, options) {
  const o = options || {};
  return h(
    "div",
    { class: "table-wrap" },
    h(
      "table",
      { class: o.class || null },
      h("thead", null, h("tr", null, headers.map((head, i) => h("th", { key: "h" + i }, head)))),
      h("tbody", null, rows),
    ),
  );
}

/* -------------------------------------------------------------------------- */
/* Fields                                                                      */
/* -------------------------------------------------------------------------- */

export function field(spec) {
  const id = spec.id || "f-" + spec.name;
  const label = h("label", { for: id }, spec.label, spec.required ? h("span", { class: "req" }, "*") : null);
  let control;
  if (spec.type === "textarea") {
    control = h("textarea", {
      id,
      name: spec.name,
      rows: spec.rows || 4,
      value: spec.value == null ? "" : String(spec.value),
      placeholder: spec.placeholder || null,
      oninput: spec.oninput || null,
      onchange: spec.onchange || null,
      disabled: spec.disabled || false,
    });
  } else if (spec.type === "select") {
    control = h(
      "select",
      {
        id,
        name: spec.name,
        value: spec.value == null ? "" : String(spec.value),
        onchange: spec.onchange || null,
        disabled: spec.disabled || false,
      },
      (spec.options || []).map((opt) =>
        h("option", { key: opt.value, value: opt.value, selected: String(opt.value) === String(spec.value) }, opt.label),
      ),
    );
  } else if (spec.type === "multi_select") {
    // A native multiple `<select>`, as on the server. `onchange` is handed the
    // selected values rather than the event, because every caller wants the
    // list and none of them wants to walk `selectedOptions`.
    control = h(
      "select",
      {
        id,
        name: spec.name,
        multiple: true,
        size: Math.min(6, (spec.options || []).length || 3),
        disabled: spec.disabled || false,
        onchange: spec.onchange ? (ev) => spec.onchange([...ev.target.selectedOptions].map((o) => o.value)) : null,
      },
      (spec.options || []).map((opt) =>
        h(
          "option",
          { key: opt.value, value: opt.value, selected: Array.isArray(spec.value) && spec.value.includes(opt.value) },
          opt.label,
        ),
      ),
    );
  } else if (spec.type === "radio") {
    // A `<fieldset>` of radios, not a checkbox and not a select: a checkbox
    // cannot tell "unanswered" from "no", and INV-05-5 has to tell them apart
    // to know whether a required criterion was answered.
    return h(
      "fieldset",
      { class: cx("field", spec.error && "field-error") },
      h("legend", null, spec.label, spec.required ? h("span", { class: "req" }, "*") : null),
      spec.help ? h("p", { class: "help" }, spec.help) : null,
      (spec.options || []).map((opt, i) =>
        h(
          "div",
          { key: opt.value, class: "checkline" },
          h("input", {
            id: id + "_" + i,
            type: "radio",
            name: spec.name,
            value: opt.value,
            checked: String(spec.value == null ? "" : spec.value) === String(opt.value),
            onchange: spec.onchange || null,
            disabled: spec.disabled || false,
          }),
          h(
            "label",
            { for: id + "_" + i },
            opt.label,
            opt.description ? h("span", { class: "muted small" }, " — " + opt.description) : null,
          ),
        ),
      ),
      spec.error ? h("p", { class: "err small" }, spec.error) : null,
    );
  } else if (spec.type === "checkbox") {
    // `.checkline` inside `.field`, not both on one element: `.field` is a
    // column and `.checkline` is a row, and an element carrying both stacks the
    // box above its own label.
    return h(
      "div",
      { class: "field" },
      h(
        "div",
        { class: "checkline" },
        h("input", {
          id,
          type: "checkbox",
          name: spec.name,
          checked: Boolean(spec.value),
          onchange: spec.onchange || null,
          disabled: spec.disabled || false,
        }),
        h("label", { for: id }, spec.label),
      ),
      spec.help ? h("p", { class: "help" }, spec.help) : null,
    );
  } else {
    control = h("input", {
      id,
      type: spec.type || "text",
      name: spec.name,
      // A rubric's scale is on the control, as it is on the server: `1..5` typed
      // into a box that accepts anything is a criterion scored 50 by a slip.
      min: spec.min === undefined ? null : spec.min,
      max: spec.max === undefined ? null : spec.max,
      step: spec.step === undefined ? null : spec.step,
      value: spec.value == null ? "" : String(spec.value),
      placeholder: spec.placeholder || null,
      oninput: spec.oninput || null,
      onchange: spec.onchange || null,
      disabled: spec.disabled || false,
      // `readonly`, not `disabled`, for a value the reader is meant to copy:
      // a disabled input is unselectable in Safari, and the one place this is
      // used shows a link that is never readable again (INV-01-15).
      readonly: spec.readonly || false,
      autocomplete: spec.autocomplete || "off",
    });
  }
  return h(
    "div",
    { class: cx("field", spec.error && "field-error") },
    label,
    control,
    spec.error ? h("p", { class: "err small" }, spec.error) : spec.help ? h("p", { class: "help" }, spec.help) : null,
  );
}

/* -------------------------------------------------------------------------- */
/* Icons — 16px, currentColor, decorative                                      */
/* -------------------------------------------------------------------------- */

function icon(paths, options) {
  const o = options || {};
  return h(
    "svg",
    {
      class: cx("console-icon", o.class),
      width: o.size || 16,
      height: o.size || 16,
      viewBox: "0 0 16 16",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": o.weight || 1.6,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true",
      focusable: "false",
    },
    paths.map((d, i) => (typeof d === "string" ? h("path", { key: i, d }) : h(d.tag, Object.assign({ key: i }, d.attrs)))),
  );
}

export const icons = {
  drag: () => icon([{ tag: "circle", attrs: { cx: 6, cy: 4, r: 1 } }, { tag: "circle", attrs: { cx: 6, cy: 8, r: 1 } }, { tag: "circle", attrs: { cx: 6, cy: 12, r: 1 } }, { tag: "circle", attrs: { cx: 10, cy: 4, r: 1 } }, { tag: "circle", attrs: { cx: 10, cy: 8, r: 1 } }, { tag: "circle", attrs: { cx: 10, cy: 12, r: 1 } }], { weight: 0, class: "console-grip" }),
  plus: () => icon(["M8 3.5v9", "M3.5 8h9"]),
  search: () => icon([{ tag: "circle", attrs: { cx: 7, cy: 7, r: 4.2 } }, "M10.2 10.2 13.5 13.5"]),
  close: () => icon(["M4 4l8 8", "M12 4l-8 8"]),
  chevronDown: () => icon(["M4 6.5 8 10.5l4-4"]),
  chevronRight: () => icon(["M6.5 4 10.5 8l-4 4"]),
  check: () => icon(["M3.5 8.5 6.5 11.5 12.5 4.5"]),
  warning: () => icon(["M8 2.8 14.2 13.2H1.8L8 2.8Z", "M8 6.6v3", "M8 11.2v.01"]),
  copy: () => icon([{ tag: "rect", attrs: { x: 5.5, y: 5.5, width: 8, height: 8, rx: 1.5 } }, "M10.5 5.5v-1a1.5 1.5 0 0 0-1.5-1.5H4a1.5 1.5 0 0 0-1.5 1.5V9a1.5 1.5 0 0 0 1.5 1.5h1"]),
  trash: () => icon(["M3 4.5h10", "M6.5 4.5v-1a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1", "M4.5 4.5 5 13a1 1 0 0 0 1 .9h4a1 1 0 0 0 1-.9l.5-8.5"]),
  eye: () => icon(["M1.8 8S4.3 3.8 8 3.8 14.2 8 14.2 8 11.7 12.2 8 12.2 1.8 8 1.8 8Z", { tag: "circle", attrs: { cx: 8, cy: 8, r: 1.8 } }]),
  settings: () => icon([{ tag: "circle", attrs: { cx: 8, cy: 8, r: 2.2 } }, "M8 1.6v1.6M8 12.8v1.6M14.4 8h-1.6M3.2 8H1.6M12.5 3.5l-1.1 1.1M4.6 11.4l-1.1 1.1M12.5 12.5l-1.1-1.1M4.6 4.6 3.5 3.5"]),
  filter: () => icon(["M2.5 4h11", "M4.5 8h7", "M6.5 12h3"]),
  menu: () => icon(["M2.5 4h11", "M2.5 8h11", "M2.5 12h11"]),
  lock: () => icon([{ tag: "rect", attrs: { x: 3.5, y: 7, width: 9, height: 6.5, rx: 1.5 } }, "M5.8 7V5.2a2.2 2.2 0 0 1 4.4 0V7"]),
  people: () => icon([{ tag: "circle", attrs: { cx: 6, cy: 5.5, r: 2.3 } }, "M1.8 13a4.2 4.2 0 0 1 8.4 0", "M10.6 3.6a2.3 2.3 0 0 1 0 4.4", "M11.6 9.6a4.2 4.2 0 0 1 2.6 3.4"]),
};

/* -------------------------------------------------------------------------- */
/* Field-type glyphs — the picker in the form builder                          */
/* -------------------------------------------------------------------------- */

/**
 * One glyph per `FieldType` (02). A picker of sixteen options reads as a wall
 * of words without them; with them the reader is choosing a shape, which is
 * what they are actually choosing.
 */
export const FIELD_GLYPH = {
  short_text: "T",
  long_text: "¶",
  markdown: "M↓",
  email: "@",
  url: "↗",
  number: "#",
  single_select: "◉",
  multi_select: "☰",
  checkbox: "☑",
  date: "▤",
  file: "📎",
  speaker_list: "👥",
  track_picker: "◈",
  format_picker: "▭",
  duration_picker: "⏱",
  consent: "✓",
};
