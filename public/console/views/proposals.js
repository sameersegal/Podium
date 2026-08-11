/**
 * `/admin/events/:eventId/proposals` — the proposal board.
 *
 * The data-dense screen R30 names as the reason the console exists. A chair
 * reads this one during a round more than every other admin screen combined,
 * and what they need from it changes by the week: while the call is open it is
 * "what came in today", during assignment it is "which of these has nobody on
 * it", at decision time it is track, format and score.
 *
 * So the columns are the reader's, not the designer's. A preferences panel
 * chooses which of them are shown and in what order, and the choice is
 * remembered per person and per event. That is the one thing a fixed five-column
 * table can never do, and the reason the old screen was always missing exactly
 * the column you needed.
 *
 * Two rules the board keeps:
 *
 * - **Filters live in the URL.** A chair who has narrowed to "submitted, AI
 *   track, no reviews yet" can send that to a co-chair, and the back button
 *   works. State that only exists in a JS object is state nobody can share.
 * - **PII is the server's decision.** `submitter_email` arrives null unless the
 *   reader is entitled to it, so the column renders empty rather than the
 *   client deciding what to hide (INV-09-5 / INV-11-4).
 */

import { h, cx, redraw, debounce } from "../kit.js";
import { api, unwrap } from "../api.js";
import { can, resource, reload, toast, reportError } from "../store.js";
import { setChrome } from "../chrome.js";
import { location, setQuery } from "../router.js";
import { badge, button, card, empty, formatDate, humanise, icons, notice, pageHead, pluralise } from "../ui.js";
import { beginDrag, dropsAt, isDragging } from "../dnd.js";

/* -------------------------------------------------------------------------- */
/* The column catalogue                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Every column the board can show, grouped the way the picker groups them.
 *
 * `render` takes the row and returns a vnode or a string. Keeping the whole
 * definition in one table is what lets the picker, the header and the body stay
 * in step — a column added here appears in all three.
 */
const COLUMNS = [
  { key: "reference", label: "Reference", group: "Identity", type: "text", render: (r) => h("span", { class: "mono small" }, r.reference) },
  {
    key: "title",
    label: "Title",
    group: "Identity",
    type: "text",
    render: (r) => h("a", { href: "/admin/proposals/" + r.id, class: "board-title" }, r.title || "Untitled"),
  },
  { key: "status", label: "Status", group: "Identity", type: "choice", render: (r) => badge(r.status) },
  { key: "origin", label: "Origin", group: "Identity", type: "choice", render: (r) => humanise(r.origin) },
  { key: "speaker_names", label: "Speakers", group: "People", type: "text", render: (r) => r.speaker_names || dash() },
  { key: "submitter_name", label: "Submitter", group: "People", type: "text", render: (r) => r.submitter_name || dash() },
  {
    key: "submitter_email",
    label: "Submitter email",
    group: "People",
    type: "text",
    pii: true,
    render: (r) => (r.submitter_email ? h("span", { class: "small" }, r.submitter_email) : withheld()),
  },
  { key: "sponsor_name", label: "Sponsor", group: "People", type: "text", render: (r) => r.sponsor_name || dash() },
  { key: "track_name", label: "Track", group: "Session details", type: "choice", render: (r) => r.track_name || dash() },
  { key: "format_name", label: "Format", group: "Session details", type: "choice", render: (r) => r.format_name || dash() },
  {
    key: "requested_duration_minutes",
    label: "Duration",
    group: "Session details",
    type: "number",
    render: (r) => (r.requested_duration_minutes ? r.requested_duration_minutes + " min" : dash()),
  },
  { key: "audience_level", label: "Level", group: "Session details", type: "choice", render: (r) => (r.audience_level ? humanise(r.audience_level) : dash()) },
  { key: "language", label: "Language", group: "Session details", type: "text", render: (r) => r.language || dash() },
  { key: "keywords", label: "Keywords", group: "Session details", type: "text", render: (r) => (r.keywords?.length ? r.keywords.join(", ") : dash()) },
  {
    key: "review_count",
    label: "Reviews in",
    group: "Review",
    type: "number",
    render: (r) =>
      h(
        "span",
        { class: cx("board-reviews", r.target_reviews && r.review_count < r.target_reviews && "is-short") },
        r.target_reviews ? r.review_count + " / " + r.target_reviews : String(r.review_count),
      ),
  },
  { key: "recording_consent", label: "Recording consent", group: "Review", type: "choice", render: (r) => humanise(r.recording_consent) },
  { key: "coi_disclosure", label: "Disclosed conflicts", group: "Review", type: "text", render: (r) => r.coi_disclosure || dash() },
  { key: "is_late", label: "Late", group: "Review", type: "choice", render: (r) => (r.is_late ? badge("late", "warn") : dash()) },
  { key: "submitted_at", label: "Submitted", group: "Dates", type: "date", render: (r) => (r.submitted_at ? formatDate(r.submitted_at) : dash()) },
  { key: "created_at", label: "Created", group: "Dates", type: "date", render: (r) => formatDate(r.created_at) },
  { key: "last_activity_at", label: "Last activity", group: "Dates", type: "date", render: (r) => formatDate(r.last_activity_at) },
  {
    key: "confirmation_deadline",
    label: "Confirm by",
    group: "Dates",
    type: "date",
    render: (r) => (r.confirmation_deadline ? formatDate(r.confirmation_deadline) : dash()),
  },
];

const COLUMN_BY_KEY = new Map(COLUMNS.map((c) => [c.key, c]));
const GROUP_ORDER = ["Identity", "People", "Session details", "Review", "Dates"];
const DEFAULT_COLUMNS = ["reference", "title", "status", "track_name", "format_name", "speaker_names", "review_count", "submitted_at"];

const TYPE_GLYPH = { text: "T", choice: "◉", number: "#", date: "▤" };

const dash = () => h("span", { class: "muted" }, "—");
/** Not "empty" — the value exists and this reader is not entitled to it. */
const withheld = () => h("span", { class: "muted small", title: "Withheld — personal data" }, "•••");

/* -------------------------------------------------------------------------- */
/* Column choice, remembered                                                   */
/* -------------------------------------------------------------------------- */

const ui = { picker: false, search: "", selection: null, loadedFor: null };

function storageKey(eventId) {
  return "podium.board.columns." + eventId;
}

function selection(eventId) {
  if (ui.selection && ui.loadedFor === eventId) return ui.selection;
  let next = DEFAULT_COLUMNS;
  try {
    const raw = window.localStorage.getItem(storageKey(eventId));
    if (raw) {
      const parsed = JSON.parse(raw);
      // Filtered against the catalogue: a column removed from the product must
      // not resurrect itself out of someone's browser storage.
      if (Array.isArray(parsed)) next = parsed.filter((k) => COLUMN_BY_KEY.has(k));
    }
  } catch {
    next = DEFAULT_COLUMNS;
  }
  ui.selection = next.length ? next : DEFAULT_COLUMNS;
  ui.loadedFor = eventId;
  return ui.selection;
}

function setSelection(eventId, keys) {
  ui.selection = keys.length ? keys : DEFAULT_COLUMNS;
  ui.loadedFor = eventId;
  try {
    window.localStorage.setItem(storageKey(eventId), JSON.stringify(ui.selection));
  } catch {
    // A browser refusing storage is not a reason to refuse the change.
  }
  redraw();
}

/* -------------------------------------------------------------------------- */
/* The screen                                                                  */
/* -------------------------------------------------------------------------- */

const STATUSES = ["draft", "submitted", "in_review", "changes_requested", "accepted", "waitlisted", "rejected", "withdrawn"];
const SORTS = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "reference", label: "Reference" },
  { value: "title", label: "Title" },
  { value: "submitted", label: "Recently submitted" },
  { value: "status", label: "Status" },
];

export function proposals(params) {
  setChrome({ section: "proposals", title: "Proposals" });

  if (!can("proposal.read_any")) {
    return card(notice("You do not have access to this event's proposals.", "warn"), "Proposals");
  }

  const query = location.query;
  const search = new URLSearchParams();
  search.set("event_id", params.eventId);
  for (const key of ["status", "track_id", "format_id", "origin", "q", "sort"]) {
    for (const value of query.getAll(key)) if (value) search.append(key, value);
  }
  search.set("limit", "100");

  const key = "proposals:" + params.eventId + ":" + search.toString();
  const res = resource(key, () => api.get("/v1/proposals?" + search.toString()));

  const cols = selection(params.eventId).map((k) => COLUMN_BY_KEY.get(k)).filter(Boolean);

  return h(
    "div",
    { class: "board" },
    pageHead(
      "Proposals",
      "Everything submitted to this event's calls.",
      h(
        "div",
        { class: "console-actions" },
        res.data ? h("span", { class: "muted small" }, res.data.total + " " + pluralise(res.data.total, "proposal")) : null,
        button(
          h("span", null, icons.settings(), " Columns ", h("span", { class: "board-count" }, cols.length + "/" + COLUMNS.length)),
          () => {
            ui.picker = !ui.picker;
            redraw();
          },
          { variant: "secondary" },
        ),
      ),
    ),
    filterBar(params, query),
    ui.picker ? columnPicker(params.eventId) : null,
    res.error ? card(notice(res.error.message, "err")) : null,
    res.data ? table(res.data, cols, key) : res.error ? null : skeletonRows(),
  );
}

/* -------------------------------------------------------------------------- */
/* Filters                                                                     */
/* -------------------------------------------------------------------------- */

const pushQuery = debounce((patch) => setQuery(patch), 300);

function filterBar(params, query) {
  const active = new Set(query.getAll("status"));
  return h(
    "div",
    { class: "board-filters" },
    h(
      "div",
      { class: "console-search board-search" },
      icons.search(),
      h("input", {
        type: "search",
        placeholder: "Search title, reference, abstract or submitter…",
        "aria-label": "Search proposals",
        value: query.get("q") || "",
        oninput: (e) => pushQuery({ q: e.target.value }),
      }),
    ),
    h(
      "div",
      { class: "board-chips", role: "group", "aria-label": "Filter by status" },
      STATUSES.map((s) =>
        h(
          "button",
          {
            key: s,
            type: "button",
            class: cx("board-chip", active.has(s) && "is-on"),
            "aria-pressed": active.has(s) ? "true" : "false",
            onclick: () => toggleStatus(query, s),
          },
          humanise(s),
        ),
      ),
      active.size
        ? h("button", { type: "button", class: "board-chip is-clear", onclick: () => setQuery({ status: null }) }, "Clear")
        : null,
    ),
    h(
      "label",
      { class: "board-sort" },
      h("span", { class: "small muted" }, "Sort"),
      h(
        "select",
        { value: query.get("sort") || "newest", onchange: (e) => setQuery({ sort: e.target.value }) },
        SORTS.map((s) => h("option", { key: s.value, value: s.value, selected: (query.get("sort") || "newest") === s.value }, s.label)),
      ),
    ),
  );
}

/**
 * Status is multi-valued, and `setQuery` takes one value per key — so the whole
 * set is rewritten here rather than patched.
 */
function toggleStatus(query, value) {
  const next = new Set(query.getAll("status"));
  if (next.has(value)) next.delete(value);
  else next.add(value);
  const url = new URL(window.location.href);
  url.searchParams.delete("status");
  for (const s of next) url.searchParams.append("status", s);
  window.history.replaceState({}, "", url.pathname + (url.search || ""));
  location.search = url.search;
  location.query = new URLSearchParams(url.search);
  redraw();
}

/* -------------------------------------------------------------------------- */
/* The table                                                                   */
/* -------------------------------------------------------------------------- */

function table(payload, cols, key) {
  if (!payload.data.length) {
    return card(empty("No proposal matches these filters."));
  }
  return h(
    "div",
    { class: "table-wrap board-table" },
    h(
      "table",
      null,
      h("thead", null, h("tr", null, cols.map((c) => h("th", { key: c.key, class: cx(c.type === "number" && "num") }, c.label)))),
      h(
        "tbody",
        null,
        payload.data.map((row) =>
          h(
            "tr",
            { key: row.id },
            cols.map((c) => h("td", { key: c.key, class: cx(c.type === "number" && "num") }, c.render(row))),
          ),
        ),
      ),
    ),
    payload.next_cursor
      ? h(
          "p",
          { class: "board-more" },
          button("Load more", () => loadMore(payload, key), { variant: "secondary" }),
        )
      : null,
  );
}

async function loadMore(payload, key) {
  try {
    const url = new URL(window.location.origin + "/v1/proposals");
    const base = key.slice(key.indexOf(":", key.indexOf(":") + 1) + 1);
    for (const [k, v] of new URLSearchParams(base)) url.searchParams.append(k, v);
    url.searchParams.set("cursor", payload.next_cursor);
    const next = await api.get(url.pathname + url.search);
    payload.data.push(...next.data);
    payload.next_cursor = next.next_cursor;
    redraw();
  } catch (err) {
    reportError(err);
  }
}

function skeletonRows() {
  return h("div", { class: "console-skeleton" }, h("div", { class: "console-skeleton-card" }));
}

/* -------------------------------------------------------------------------- */
/* The column picker                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Two panes: everything available on the left, what is shown on the right in
 * the order it is shown. The right pane drags to reorder, because "which
 * columns" and "in what order" are one decision and splitting them across two
 * screens is how people end up with the right columns in the wrong order.
 */
function columnPicker(eventId) {
  const chosen = selection(eventId);
  const chosenSet = new Set(chosen);
  const q = ui.search.trim().toLowerCase();
  const groups = GROUP_ORDER.map((name) => ({
    name,
    // The group name matches too: someone looking for a date column
    // types "date", which is the section's name and no column's label.
    items: COLUMNS.filter(
      (c) => c.group === name && (!q || c.label.toLowerCase().includes(q) || c.key.includes(q) || c.group.toLowerCase().includes(q)),
    ),
  })).filter((g) => g.items.length);

  return h(
    "section",
    { class: "card board-picker" },
    h(
      "header",
      { class: "board-picker-head" },
      h("h2", null, "Columns"),
      h("span", { class: "muted small" }, chosen.length + " of " + COLUMNS.length + " shown"),
      h("span", { class: "spacer" }),
      button("Reset to default", () => setSelection(eventId, DEFAULT_COLUMNS), { variant: "secondary", size: "small" }),
      h(
        "button",
        { type: "button", class: "console-icon-btn", "aria-label": "Close the column picker", onclick: () => { ui.picker = false; redraw(); } },
        icons.close(),
      ),
    ),
    h(
      "div",
      { class: "board-picker-cols" },
      h(
        "div",
        { class: "board-picker-available" },
        h(
          "div",
          { class: "console-search" },
          icons.search(),
          h("input", {
            type: "search",
            placeholder: "Search columns…",
            "aria-label": "Search columns",
            value: ui.search,
            oninput: (e) => {
              ui.search = e.target.value;
              redraw();
            },
          }),
        ),
        h(
          "div",
          { class: "board-picker-list" },
          groups.length
            ? groups.map((g) =>
                h(
                  "section",
                  { key: g.name },
                  h(
                    "h3",
                    null,
                    g.name,
                    h("span", { class: "muted" }, " " + g.items.filter((c) => chosenSet.has(c.key)).length + "/" + g.items.length),
                  ),
                  h(
                    "ul",
                    null,
                    g.items.map((c) =>
                      h(
                        "li",
                        { key: c.key },
                        h(
                          "label",
                          { class: cx("board-option", chosenSet.has(c.key) && "is-on") },
                          h("input", {
                            type: "checkbox",
                            checked: chosenSet.has(c.key),
                            onchange: () => toggleColumn(eventId, c.key),
                          }),
                          h("span", { class: "board-glyph", "aria-hidden": "true" }, TYPE_GLYPH[c.type] || "?"),
                          h("span", { class: "board-option-body" }, h("span", null, c.label), h("span", { class: "board-option-type" }, humanise(c.type))),
                          c.pii ? h("span", { class: "badge err", title: "Personal data" }, "PII") : null,
                        ),
                      ),
                    ),
                  ),
                ),
              )
            : empty("No column matches “" + ui.search + "”."),
        ),
      ),
      h(
        "div",
        { class: "board-picker-selected" },
        h("h3", null, "Shown, in order"),
        h("p", { class: "small muted" }, "Drag to reorder."),
        h(
          "ul",
          { class: "board-selected", "data-dnd-group": "column", "data-dnd-id": "columns" },
          chosen.map((k, i) => {
            const c = COLUMN_BY_KEY.get(k);
            if (!c) return null;
            return [
              dropsAt("columns", i) ? h("li", { key: "line-" + k, class: "console-insertion", "aria-hidden": "true" }) : null,
              h(
                "li",
                {
                  key: k,
                  class: cx("board-selected-item", isDragging(k) && "console-dragged"),
                  "data-dnd-item": "column",
                  "data-dnd-id": k,
                },
                h(
                  "button",
                  {
                    type: "button",
                    class: "console-grip-btn",
                    "aria-label": "Drag to reorder " + c.label,
                    onpointerdown: (ev) =>
                      beginDrag(ev, { kind: "column", id: k, label: c.label, fromGroup: "columns", fromIndex: i }, (item, groupId, to) =>
                        moveColumn(eventId, item.id, to),
                      ),
                  },
                  icons.drag(),
                ),
                h("span", { class: "board-glyph", "aria-hidden": "true" }, TYPE_GLYPH[c.type] || "?"),
                h("span", { class: "board-selected-label" }, c.label),
                h(
                  "div",
                  { class: "console-row-actions" },
                  button("↑", () => moveColumn(eventId, k, i - 1), { variant: "secondary", size: "small", disabled: i === 0, ariaLabel: "Move " + c.label + " up" }),
                  button("↓", () => moveColumn(eventId, k, i + 1), { variant: "secondary", size: "small", disabled: i === chosen.length - 1, ariaLabel: "Move " + c.label + " down" }),
                  h(
                    "button",
                    { type: "button", class: "console-icon-btn", "aria-label": "Remove " + c.label, onclick: () => toggleColumn(eventId, k) },
                    icons.close(),
                  ),
                ),
              ),
            ];
          }),
          dropsAt("columns", chosen.length) ? h("li", { key: "line-end", class: "console-insertion", "aria-hidden": "true" }) : null,
        ),
      ),
    ),
  );
}

function toggleColumn(eventId, key) {
  const chosen = selection(eventId);
  if (chosen.includes(key)) {
    if (chosen.length === 1) return toast("warn", "A board needs at least one column.");
    setSelection(eventId, chosen.filter((k) => k !== key));
  } else {
    setSelection(eventId, [...chosen, key]);
  }
}

function moveColumn(eventId, key, toIndex) {
  const chosen = [...selection(eventId)];
  const from = chosen.indexOf(key);
  if (from < 0) return;
  chosen.splice(from, 1);
  chosen.splice(Math.max(0, Math.min(chosen.length, toIndex)), 0, key);
  setSelection(eventId, chosen);
}
