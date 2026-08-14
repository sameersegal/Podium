/**
 * The instrument the product-taste agent walks with.
 *
 * A taste review is a judgement, and a judgement made from memory is worthless:
 * by the time you have finished a flow you know how it works, and you can no
 * longer see that the screen never told you. So this records the walk as it
 * happens — a note per screen, written before the next click, with a screenshot
 * beside it and a handful of mechanical readings the eye is bad at.
 *
 * It measures what the product *charges*: screens opened, actions spent, fields
 * filled, attempts re-done. It deliberately does not time anything. A script
 * clicks in eight milliseconds and a speaker on a sofa takes forty seconds, and
 * quoting the former as the latter would be the most confident lie in the
 * report.
 *
 * Usage — the agent writes one small script per journey and runs it:
 *
 *   import { walk } from "<repo>/.claude/agents/product-taste/scripts/walk.mjs";
 *
 *   const w = await walk({ journey: "speaker-submits-a-proposal", role: "speaker", viewport: "phone" });
 *   await w.session("Sunday night, on the sofa");
 *   await w.goto("/e/devflow-2027/cfp/main");
 *   await w.note({
 *     screen: "The CFP page",
 *     expected: "what I thought I would find before it loaded",
 *     saw: "the first three seconds, before I read it properly",
 *     did: "what I clicked and why",
 *     felt: "the honest reaction",
 *     questions: ["what this screen left me unable to answer"],
 *   });
 *   await w.act("start a proposal", () => w.page.click("text=Submit a proposal"));
 *   ...
 *   await w.session("Tuesday lunchtime, back at a laptop", { carry: "cookies" });
 *   ...
 *   await w.finish();
 *
 * Everything lands in the output directory: `journal.md` to read, `journal.jsonl`
 * to diff between runs, and numbered PNGs. Nothing is written into the
 * repository — the report is, and the agent writes that itself.
 */

import { chromium } from "playwright";
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

const VIEWPORTS = {
  phone: { width: 390, height: 844, isMobile: true, hasTouch: true },
  desktop: { width: 1440, height: 900, isMobile: false, hasTouch: false },
};

/** Everything a person can put a finger or a cursor on. */
const INTERACTIVE = 'a[href], button, input, select, textarea, summary, [role="button"], [tabindex]:not([tabindex="-1"])';

/**
 * Words on a screen that belong to the people who built it rather than the
 * person reading it. The repository already forbids these in rendered strings;
 * finding one on a walk is the cheapest possible evidence that a screen was
 * finished by somebody who was thinking about the schema.
 */
const JARGON = [
  { name: "invariant citation", re: /\bINV-\d{2}-\d+\b/g },
  { name: "decision record", re: /\bR\d{1,2}\b(?=[\s,.)—:])/g },
  { name: "column or entity name", re: /\b[a-z]{3,}(?:_[a-z]{2,}){1,}\b/g },
  { name: "context number", re: /\((?:0[0-9]|1[0-5])\)/g },
];

export async function walk(options) {
  const {
    journey,
    role,
    task = null,
    viewport = "desktop",
    base = process.env.PODIUM_BASE ?? "http://localhost:8787",
    out = process.env.PODIUM_WALK_DIR ?? path.join(process.cwd(), ".walk"),
  } = options;

  if (!journey || !role) throw new Error("walk() needs at least { journey, role }");
  if (!VIEWPORTS[viewport]) throw new Error(`viewport must be one of ${Object.keys(VIEWPORTS).join(", ")}`);

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const browser = await chromium.launch(
    process.env.PODIUM_CHROMIUM ? { executablePath: process.env.PODIUM_CHROMIUM } : {},
  );

  /** Counters. These are the report's numbers, so nothing increments them by guess. */
  const tally = { sessions: 0, screens: 0, navigations: 0, actions: 0, fields: 0, attempts: 0, notes: 0 };

  const state = {
    context: null,
    page: null,
    session: null,
    /** Console errors and failed requests seen since the last note was written. */
    noise: [],
    /** Cookies carried across a session boundary, if the scenario says they survive. */
    storage: null,
    lastStatus: null,
    viewport,
    shot: 0,
  };

  const jsonl = path.join(out, "journal.jsonl");
  const md = path.join(out, "journal.md");

  const record = (entry) => appendFileSync(jsonl, JSON.stringify(entry) + "\n");

  /**
   * A walk that falls over is still a walk, and the screen it fell over on is
   * usually the most interesting one in the report. Every record is already on
   * disk; this makes sure the readable journal gets written even when the
   * script dies half way — otherwise a dead end costs you the evidence of it.
   */
  const meta = () => ({ journey, role, task, viewport, base, tally });
  const flush = () => {
    try {
      writeFileSync(md, renderJournal(jsonl, meta()));
    } catch {
      /* nothing useful to do here; the JSONL is the record */
    }
  };
  for (const signal of ["uncaughtException", "unhandledRejection"]) {
    process.on(signal, (err) => {
      flush();
      console.error(`walk stopped on ${signal}: ${err}`);
      console.error(`the journal up to that point is in ${md}`);
      process.exit(1);
    });
  }

  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);

  async function openContext(label, carry, on) {
    if (state.context) {
      if (carry === "cookies") state.storage = await state.context.storageState();
      await state.context.close();
    }
    if (carry === "nothing") state.storage = null;
    state.viewport = on;

    state.context = await browser.newContext({
      viewport: { width: VIEWPORTS[on].width, height: VIEWPORTS[on].height },
      isMobile: VIEWPORTS[on].isMobile,
      hasTouch: VIEWPORTS[on].hasTouch,
      deviceScaleFactor: 2,
      storageState: state.storage ?? undefined,
    });
    state.page = await state.context.newPage();
    state.noise = [];

    // Anything the browser complains about belongs in the journal whether or not
    // the walker noticed it. A page that works and logs four errors is a page
    // that is about to stop working.
    state.page.on("console", (m) => {
      if (m.type() === "error") state.noise.push({ kind: "console", text: m.text().slice(0, 300) });
    });
    state.page.on("pageerror", (e) => state.noise.push({ kind: "pageerror", text: String(e).slice(0, 300) }));
    state.page.on("requestfailed", (r) => state.noise.push({ kind: "requestfailed", text: `${r.method()} ${r.url()}`.slice(0, 300) }));
    state.page.on("response", (r) => {
      if (r.status() >= 400) state.noise.push({ kind: `http ${r.status()}`, text: `${r.request().method()} ${r.url()}`.slice(0, 300) });
    });

    state.session = { label, carry, opened: tally.screens };
    tally.sessions++;
    record({ type: "session", label, carry, viewport: on });
  }

  /**
   * The mechanical readings. None of these is a taste finding on its own — a
   * screen can pass all four and still be miserable, and the agent's eye is the
   * point. They exist because these particular defects are invisible to a
   * reader who already knows what the screen meant to say.
   */
  async function probe() {
    return state.page.evaluate(
      ({ INTERACTIVE, jargon, isPhone }) => {
        const visibleText = document.body.innerText || "";

        const leaks = [];
        for (const { name, source, flags } of jargon) {
          const re = new RegExp(source, flags);
          const seen = new Set();
          let m;
          while ((m = re.exec(visibleText)) !== null) {
            if (seen.has(m[0])) continue;
            seen.add(m[0]);
            const at = Math.max(0, m.index - 40);
            leaks.push({ kind: name, term: m[0], context: visibleText.slice(at, m.index + m[0].length + 40).replace(/\s+/g, " ") });
          }
        }

        const small = [];
        if (isPhone) {
          for (const el of document.querySelectorAll(INTERACTIVE)) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 && r.height === 0) continue;
            if (getComputedStyle(el).visibility === "hidden") continue;
            if (r.height < 44 || r.width < 24) {
              small.push({
                text: (el.innerText || el.value || el.getAttribute("aria-label") || el.tagName).trim().slice(0, 40),
                size: `${Math.round(r.width)}×${Math.round(r.height)}`,
              });
            }
          }
        }

        const unlabelled = [];
        for (const el of document.querySelectorAll("input, select, textarea")) {
          if (el.type === "hidden" || el.type === "submit" || el.type === "button") continue;
          const named =
            el.labels?.length > 0 ||
            el.getAttribute("aria-label") ||
            el.getAttribute("aria-labelledby") ||
            el.closest("label");
          if (!named) unlabelled.push({ name: el.name || el.id || el.tagName, type: el.type || el.tagName });
        }

        const fields = [...document.querySelectorAll("input, select, textarea")].filter(
          (el) => !["hidden", "submit", "button"].includes(el.type),
        );

        return {
          horizontalScroll:
            document.documentElement.scrollWidth > window.innerWidth + 1
              ? { scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }
              : null,
          jargon: leaks,
          smallTargets: small,
          unlabelledFields: unlabelled,
          fieldCount: fields.length,
          requiredFieldCount: fields.filter((el) => el.required || el.getAttribute("aria-required") === "true").length,
          title: document.title,
          h1: document.querySelector("h1")?.innerText?.trim() ?? null,
          pageHeight: document.documentElement.scrollHeight,
        };
      },
      {
        INTERACTIVE,
        jargon: JARGON.map((j) => ({ name: j.name, source: j.re.source, flags: j.re.flags })),
        isPhone: VIEWPORTS[state.viewport].isMobile,
      },
    );
  }

  const api = {
    get page() {
      return state.page;
    },
    base,
    out,
    tally,

    /**
     * A visit. Closes the browser and opens a new one, which is what leaving
     * actually is — no in-memory state, no scroll position, no half-open menu.
     *
     * `carry: "cookies"` is the honest default for coming back to the same
     * laptop. `carry: "nothing"` is a different device, an expired session, or
     * a private window, and is worth walking at least once for any journey
     * whose whole promise is that your work is still there.
     *
     * `on` changes device between sittings, which is what people actually do:
     * start on the phone, finish at a desk. A layout that only ever gets walked
     * at one width never has to survive that.
     */
    async session(label, { carry = "cookies", on = viewport } = {}) {
      if (!VIEWPORTS[on]) throw new Error(`viewport must be one of ${Object.keys(VIEWPORTS).join(", ")}`);
      await openContext(label, state.context ? carry : "nothing", on);
      return api;
    },

    /** Open a path. Records the HTTP status, because a 302 you did not expect is a finding. */
    async goto(pathOrUrl) {
      const url = pathOrUrl.startsWith("http") ? pathOrUrl : base + pathOrUrl;
      const res = await state.page.goto(url, { waitUntil: "networkidle" });
      state.lastStatus = res?.status() ?? null;
      tally.navigations++;
      return res;
    },

    /**
     * Do something, named in the words the role would use.
     *
     * Every call is one unit of effort the product charged for. `fields` counts
     * answers typed, which is the other currency a form spends.
     */
    async act(what, fn, { fields = 0 } = {}) {
      tally.actions++;
      tally.fields += fields;
      let error = null;
      try {
        await fn();
      } catch (err) {
        error = String(err).split("\n")[0];
      }
      await state.page.waitForLoadState("networkidle").catch(() => {});
      record({ type: "act", what, fields, error, url: state.page.url() });
      if (error) throw new Error(`act(${JSON.stringify(what)}) failed: ${error}`);
      return api;
    },

    /**
     * Something that did not work the first time. Every one of these is the
     * report's hardest currency, so it is recorded where it happened rather
     * than remembered afterwards.
     */
    async attempt(what, why) {
      tally.attempts++;
      record({ type: "attempt", what, why, url: state.page.url() });
      return api;
    },

    /** An extra picture of something mid-flow, outside the per-screen note. */
    async shot(name) {
      const file = path.join(out, `${String(++state.shot).padStart(2, "0")}-${slug(name)}.png`);
      await state.page.screenshot({ path: file, fullPage: true });
      return file;
    },

    /**
     * The note. Written standing on the screen, before the next click.
     *
     * `saw` is the first three seconds, not a careful reading — most users never
     * get further than that, and the gap between the two is where taste lives.
     */
    async note({ screen, expected = null, saw = null, did = null, felt = null, questions = [] }) {
      if (!screen) throw new Error("note() needs a screen name");
      tally.screens++;
      tally.notes++;
      const readings = await probe();
      const file = path.join(out, `${String(++state.shot).padStart(2, "0")}-${slug(screen)}.png`);
      await state.page.screenshot({ path: file, fullPage: true });
      const noise = state.noise.splice(0, state.noise.length);

      const entry = {
        type: "note",
        session: state.session?.label ?? null,
        screen,
        url: state.page.url(),
        status: state.lastStatus,
        viewport: state.viewport,
        expected,
        saw,
        did,
        felt,
        questions,
        readings,
        noise,
        screenshot: path.basename(file),
      };
      record(entry);
      return entry;
    },

    /** Free-text, for something that happened between screens. */
    async aside(text) {
      record({ type: "aside", text, url: state.page?.url() ?? null });
      return api;
    },

    /**
     * Sign in without walking the login screen.
     *
     * Only for journeys where authentication is not the thing under test. When
     * getting in *is* part of the trip, type into the form like a person and
     * write a note about it.
     */
    async signIn(email, password) {
      await api.goto("/login");
      await state.page.fill('input[name="email"]', email);
      await state.page.fill('input[name="password"]', password);
      await state.page.click('button[type="submit"]');
      await state.page.waitForLoadState("networkidle");
      if (new URL(state.page.url()).pathname === "/login") {
        throw new Error(`sign-in failed for ${email} — is the dev server seeded and password login on?`);
      }
      record({ type: "aside", text: `signed in as ${email} (out of character — not part of this journey)` });
      return api;
    },

    async finish() {
      record({ type: "tally", ...tally });
      flush();
      if (state.context) await state.context.close();
      await browser.close();
      return { out, tally, journal: md };
    },
  };

  record({ type: "start", journey, role, task, viewport, base });
  return api;
}

/** The readable journal. The JSONL is the record; this is what the agent re-reads before rating. */
function renderJournal(jsonl, meta) {
  const entries = readFileSync(jsonl, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

  const out = [];
  out.push(`# Walk journal — ${meta.journey}`);
  out.push("");
  out.push(`**Role** ${meta.role}  `);
  if (meta.task) out.push(`**Task** ${meta.task}  `);
  out.push(`**Viewport** ${meta.viewport}  `);
  out.push(`**Against** ${meta.base}`);
  out.push("");
  out.push(
    `Screens ${meta.tally.screens} · actions ${meta.tally.actions} · fields ${meta.tally.fields} · ` +
      `navigations ${meta.tally.navigations} · re-dos ${meta.tally.attempts} · visits ${meta.tally.sessions}`,
  );
  out.push("");

  for (const e of entries) {
    if (e.type === "session") {
      out.push(`## Visit — ${e.label}`);
      out.push("");
      out.push(
        `_On a ${e.viewport}. Arrived carrying: ${e.carry === "cookies" ? "the session from last time" : "nothing"}._`,
      );
      out.push("");
    }
    if (e.type === "note") {
      out.push(`### ${e.screen}`);
      out.push("");
      out.push(`\`${e.url}\`${e.status ? ` — ${e.status}` : ""} · ![](${e.screenshot})`);
      out.push("");
      if (e.expected) out.push(`- **Expected** ${e.expected}`);
      if (e.saw) out.push(`- **First three seconds** ${e.saw}`);
      if (e.did) out.push(`- **Did** ${e.did}`);
      if (e.felt) out.push(`- **Felt** ${e.felt}`);
      for (const q of e.questions ?? []) out.push(`- **Could not answer from this screen** ${q}`);

      const r = e.readings;
      const flags = [];
      if (r.horizontalScroll) flags.push(`horizontal scroll (${r.horizontalScroll.scrollWidth}px in ${r.horizontalScroll.innerWidth}px)`);
      if (r.jargon?.length) flags.push(`jargon on screen: ${r.jargon.map((j) => `\`${j.term}\``).join(", ")}`);
      if (r.smallTargets?.length) flags.push(`${r.smallTargets.length} tap targets under 44px (${r.smallTargets.slice(0, 4).map((t) => `"${t.text}" ${t.size}`).join(", ")})`);
      if (r.unlabelledFields?.length) flags.push(`${r.unlabelledFields.length} fields with no label`);
      if (!r.title) flags.push("no page title");
      if (e.noise?.length) flags.push(`browser noise: ${e.noise.map((n) => `${n.kind} — ${n.text}`).join(" · ")}`);
      if (r.fieldCount) flags.push(`${r.fieldCount} fields, ${r.requiredFieldCount} marked required`);
      if (flags.length) {
        out.push("");
        out.push(`> Instruments: ${flags.join("; ")}`);
      }
      out.push("");
    }
    if (e.type === "act") out.push(`- ⟶ ${e.what}${e.fields ? ` (${e.fields} fields)` : ""}${e.error ? ` — **failed**: ${e.error}` : ""}`);
    if (e.type === "attempt") out.push(`- ↺ **re-do** ${e.what} — ${e.why}`);
    if (e.type === "aside") out.push(`- _${e.text}_`);
  }
  out.push("");
  return out.join("\n");
}
