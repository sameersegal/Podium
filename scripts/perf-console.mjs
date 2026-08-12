#!/usr/bin/env node
/**
 * Measure the admin console (R30), screen by screen, in a real browser.
 *
 * `scripts/smoke.mjs` answers "does every screen still answer 200". This
 * answers the question the console's existence raises instead: R30 accepted two
 * UI stacks in exchange for a surface that is quicker to move around in, and
 * nothing in the repository has ever checked the second half of that trade.
 *
 * Three numbers per screen, because they are three different questions:
 *
 *   cold   a fresh browser context — empty HTTP cache, cookies only. What a
 *          person gets on the first URL they open in the morning, module
 *          waterfall and all.
 *   warm   the same context reloading the same URL. Assets come from cache, so
 *          this isolates the document, the boot payload and the screen's own
 *          /v1 reads.
 *   spa    a client-side navigation into the screen — an anchor clicked through
 *          the console's own delegated listener, so it is the real code path.
 *          No document, no modules, no boot payload: only the screen's reads
 *          and its render. This is the number R30 bought.
 *
 * "Ready" is not `load`. It is the first animation frame on which the screen's
 * skeleton is gone and no `/v1` request is in flight — i.e. the frame on which
 * the reader can actually read the screen. Every view in `public/console/views/`
 * renders `.console-skeleton` while its resource is loading, which is what makes
 * one definition work for all of them.
 *
 * The document and API timings are also sampled over plain HTTP, away from the
 * browser, so a slow screen can be attributed to the server or to the client
 * rather than guessed at. The endpoint list for that pass is not hand-written:
 * it is whatever the browser was seen to fetch.
 *
 * Usage:
 *   node scripts/perf-console.mjs [--base http://localhost:8787] [--runs 5]
 *                                 [--json out.json] [--only <substring>]
 *
 * Requires Playwright, which is deliberately not a dependency of this
 * repository — nothing else here needs a browser:  npm i -D playwright
 */

import { writeFileSync } from "node:fs";
import process from "node:process";

/* -------------------------------------------------------------------------- */
/* Arguments                                                                   */
/* -------------------------------------------------------------------------- */

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const BASE = flag("base", process.env.PODIUM_BASE ?? "http://127.0.0.1:8787");
const RUNS = Number(flag("runs", "5"));
const ONLY = flag("only", null);
const JSON_OUT = flag("json", null);
const VERBOSE = argv.includes("--verbose");

/** The seed's organizer. Password login is on in the default seed (R23). */
const ORGANIZER = { email: "sbek-organizer@example.com", password: "SbekTest!2027-org" };

/* -------------------------------------------------------------------------- */
/* Statistics                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Percentiles over a handful of runs, reported as the run they came from rather
 * than interpolated: with five samples an interpolated p95 is arithmetic on
 * noise. `p95` of five runs is the slowest run, and is labelled "max" for that
 * reason wherever the sample is small.
 */
function stats(values) {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const at = (q) => xs[Math.min(xs.length - 1, Math.floor(q * xs.length))];
  return {
    n: xs.length,
    min: xs[0],
    median: xs.length % 2 ? xs[(xs.length - 1) / 2] : (xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2,
    p95: at(0.95),
    max: xs[xs.length - 1],
    mean: xs.reduce((a, b) => a + b, 0) / xs.length,
  };
}

const ms = (v) => (v == null ? "—" : v >= 100 ? String(Math.round(v)) : v.toFixed(1));
const kb = (v) => (v == null ? "—" : (v / 1024).toFixed(1));

/* -------------------------------------------------------------------------- */
/* In-page instrumentation                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Installed before any of the console's own script runs, so it sees the first
 * fetch. Three jobs: keep an in-flight count (the second half of "ready"),
 * record every request the console makes (which is where the HTTP sampling
 * pass gets its endpoint list), and hold the paint entries, since a client-side
 * navigation produces no navigation entry to hang them off.
 */
const INSTRUMENT = `
window.__perf = { inflight: 0, calls: [], longtasks: [], mark: 0 };

const nativeFetch = window.fetch;
window.fetch = function (input, init) {
  const url = typeof input === 'string' ? input : (input && input.url) || String(input);
  const method = (init && init.method) || (input && input.method) || 'GET';
  const t0 = performance.now();
  window.__perf.inflight++;
  const done = (status) => {
    window.__perf.inflight--;
    window.__perf.calls.push({ url, method, status, start: t0, end: performance.now(), since: t0 - window.__perf.mark });
  };
  return nativeFetch.call(this, input, init).then(
    (res) => { done(res.status); return res; },
    (err) => { done(0); throw err; },
  );
};

try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) window.__perf.longtasks.push({ start: e.startTime, duration: e.duration });
  }).observe({ type: 'longtask', buffered: true });
} catch (e) { /* not every build exposes longtask */ }

/**
 * The frame on which the screen became readable: skeleton gone, nothing in
 * flight, and held for two consecutive frames so a view that redraws into a
 * second skeleton is not scored on the gap between them.
 */
window.__ready = function (from) {
  return new Promise((resolve) => {
    const t0 = from == null ? 0 : from;
    let stable = 0;
    let frames = 0;
    const tick = () => {
      frames++;
      const root = document.getElementById('console');
      const busy =
        !root ||
        window.__perf.inflight > 0 ||
        root.querySelector('.console-skeleton, .console-booting') !== null ||
        root.children.length === 0;
      if (!busy) {
        stable++;
        if (stable >= 2) return resolve({ at: performance.now() - t0, frames });
      } else {
        stable = 0;
      }
      if (frames > 900) return resolve({ at: performance.now() - t0, frames, timedOut: true });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
};
`;

/** Read back what the page recorded for one document load. */
const COLLECT_NAV = `(() => {
  const nav = performance.getEntriesByType('navigation')[0] || {};
  const paint = {};
  for (const e of performance.getEntriesByType('paint')) paint[e.name] = e.startTime;
  const res = performance.getEntriesByType('resource');
  const bytes = (f) => res.filter(f).reduce((a, e) => a + (e.transferSize || e.encodedBodySize || 0), 0);
  const isScript = (e) => e.initiatorType === 'script' || /\\.js(\\?|$)/.test(e.name);
  const isStyle = (e) => e.initiatorType === 'link' || /\\.css(\\?|$)/.test(e.name);
  const scripts = res.filter(isScript);
  return {
    ttfb: nav.responseStart,
    documentMs: nav.responseEnd,
    documentBytes: nav.transferSize || nav.encodedBodySize || 0,
    documentDecoded: nav.decodedBodySize || 0,
    domContentLoaded: nav.domContentLoadedEventEnd,
    load: nav.loadEventEnd || null,
    fcp: paint['first-contentful-paint'] ?? null,
    scriptCount: scripts.length,
    scriptBytes: bytes(isScript),
    styleBytes: bytes(isStyle),
    resourceBytes: res.reduce((a, e) => a + (e.transferSize || e.encodedBodySize || 0), 0),
    // A module graph loaded depth-first shows up here: the last script to
    // finish, minus the first to start, is the waterfall.
    scriptSpan: scripts.length ? Math.max(...scripts.map((e) => e.responseEnd)) - Math.min(...scripts.map((e) => e.startTime)) : 0,
    calls: window.__perf.calls,
    longtasks: window.__perf.longtasks,
  };
})()`;

/* -------------------------------------------------------------------------- */
/* Screens                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The console's route table, from `public/console/app.js`, in the order an
 * organizer meets them. `from` is the screen a client-side navigation starts
 * on — for most it is the event dashboard, which is where their links live.
 */
function screens(ids) {
  const ev = `/admin/events/${ids.event_id}`;
  return [
    { name: "/admin", path: "/admin", view: "adminHome", from: "/admin/events" },
    { name: "/admin/events", path: "/admin/events", view: "events", from: "/admin" },
    { name: "…/events/:id", path: ev, view: "dashboard", from: "/admin/events" },
    { name: "…/:id/setup", path: `${ev}/setup`, view: "setup", from: ev },
    { name: "…/:id/cfps", path: `${ev}/cfps`, view: "cfps", from: ev },
    { name: "…/:id/proposals", path: `${ev}/proposals`, view: "proposals", from: ev },
    { name: "…/:id/review", path: `${ev}/review`, view: "review", from: ev },
    { name: "…/:id/sessions", path: `${ev}/sessions`, view: "sessions", from: ev },
    { name: "…/:id/schedule", path: `${ev}/schedule`, view: "agenda", from: ev },
    { name: "…/:id/roster", path: `${ev}/roster`, view: "roster", from: ev },
    { name: "…/:id/onboarding", path: `${ev}/onboarding`, view: "onboarding", from: ev },
    { name: "…/:id/publications", path: `${ev}/publications`, view: "publications", from: ev },
    { name: "…/cfps/:id/form", path: `/admin/cfps/${ids.cfp_id}/form`, view: "formBuilder", from: `${ev}/cfps` },
    { name: "…/proposals/:id", path: `/admin/proposals/${ids.proposal_id}`, view: "proposalDetail", from: `${ev}/proposals` },
  ];
}

/* -------------------------------------------------------------------------- */
/* The browser pass                                                            */
/* -------------------------------------------------------------------------- */

async function newContext(browser, storageState) {
  const context = await browser.newContext({
    storageState,
    viewport: { width: 1440, height: 900 },
    // A console is a desktop surface (R30). Measuring it at 1× on a laptop
    // viewport is the honest default; throttling belongs in a separate run.
    deviceScaleFactor: 1,
  });
  await context.addInitScript(INSTRUMENT);
  return context;
}

/** One document load, measured. `fresh` decides whether the HTTP cache is empty. */
async function measureLoad(browser, storageState, path, { fresh }, reuse) {
  const context = fresh ? await newContext(browser, storageState) : reuse.context;
  const page = fresh ? await context.newPage() : reuse.page;
  const res = await page.goto(BASE + path, { waitUntil: "commit" });
  const ready = await page.evaluate("window.__ready(0)");
  const nav = await page.evaluate(COLLECT_NAV);
  const out = { status: res.status(), ready: ready.at, timedOut: Boolean(ready.timedOut), ...nav };
  if (fresh) await context.close();
  return out;
}

/**
 * One client-side navigation, measured.
 *
 * The anchor is injected and clicked rather than calling the router directly:
 * `router.js` intercepts clicks on `a[href]` through one delegated listener, so
 * a synthesised click exercises the same path a real one does — including the
 * checks that decide a link is not the console's.
 */
async function clickTo(page, href) {
  const result = await page.evaluate(
    async ([target]) => {
      window.__perf.calls = [];
      const a = document.createElement("a");
      a.href = target;
      a.textContent = "perf";
      a.style.position = "fixed";
      a.style.left = "-9999px";
      document.body.appendChild(a);
      const t0 = performance.now();
      window.__perf.mark = t0;
      a.click();
      a.remove();
      const ready = await window.__ready(t0);
      return {
        ready: ready.at,
        frames: ready.frames,
        timedOut: Boolean(ready.timedOut),
        path: window.location.pathname,
        calls: window.__perf.calls,
      };
    },
    [BASE + href],
  );
  const want = new URL(BASE + href).pathname;
  if (result.path !== want) throw new Error(`client navigation to ${want} landed on ${result.path}`);
  return result;
}

/**
 * Both client-side numbers, from a document that has just booted.
 *
 * `first` is arriving at the screen for the first time this session: the
 * router swaps the view and the screen's resource loads. `revisit` is coming
 * back to it later — `store.js` holds a loaded resource for the life of the
 * document and only a write or a live frame invalidates it, so the screen
 * redraws from what is already in hand and fetches nothing. Reporting one
 * number for both would flatter the console with the second and misrepresent
 * it with the first.
 */
async function measureSpa(page, from, to) {
  await page.goto(BASE + from, { waitUntil: "commit" });
  await page.evaluate("window.__ready(0)");
  const first = await clickTo(page, to);
  await clickTo(page, from);
  const revisit = await clickTo(page, to);
  return { first, revisit };
}

/* -------------------------------------------------------------------------- */
/* The HTTP pass                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Server time for one URL, away from the browser. Same cookie, no cache, no
 * rendering — so the difference between this and the browser's number for the
 * same screen is the client's share of it.
 */
async function sampleHttp(url, cookie, runs, accept) {
  const times = [];
  let bytes = 0;
  let status = 0;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    const res = await fetch(url, { headers: { cookie, accept: accept || "text/html" } });
    const body = await res.arrayBuffer();
    times.push(performance.now() - t0);
    bytes = body.byteLength;
    status = res.status;
  }
  return { status, bytes, ...stats(times) };
}

/* -------------------------------------------------------------------------- */
/* Run                                                                         */
/* -------------------------------------------------------------------------- */

async function main() {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    console.error("This needs Playwright, which is not a dependency of this repo:\n\n  npm i -D playwright\n");
    process.exit(2);
  }

  const idsRes = await fetch(`${BASE}/dev/ids`);
  if (!idsRes.ok) {
    console.error(`${BASE}/dev/ids answered ${idsRes.status} — is \`npm run dev\` up and seeded?`);
    process.exit(2);
  }
  const ids = await idsRes.json();

  const browser = await chromium.launch();

  // Sign in once through the real form and keep the cookie for every context.
  const signin = await browser.newContext();
  const page0 = await signin.newPage();
  await page0.goto(`${BASE}/login`);
  await page0.fill('input[name="email"]', ORGANIZER.email);
  await page0.fill('input[name="password"]', ORGANIZER.password);
  // Sign-in lands wherever the server sends this person (the seed's organizer
  // is also a speaker, so it is `/portal`); all this pass needs is the cookie.
  await Promise.all([
    page0.waitForURL((url) => !url.pathname.startsWith("/login")),
    page0.click('button[type="submit"], input[type="submit"]'),
  ]);
  const storageState = await signin.storageState();
  await signin.close();
  const cookie = storageState.cookies.map((c) => `${c.name}=${c.value}`).join("; ");

  const list = screens(ids).filter((s) => !ONLY || s.path.includes(ONLY) || s.name.includes(ONLY) || s.view.includes(ONLY));

  // One long-lived context for the warm and client-side passes — which is also
  // what a console session is: one document, open all day.
  const warmContext = await newContext(browser, storageState);
  const warmPage = await warmContext.newPage();

  const results = [];
  const seenCalls = new Map();

  for (const screen of list) {
    process.stderr.write(`  ${screen.name} `);
    const row = { ...screen, cold: [], warm: [], spa: [], spaRevisit: [] };

    for (let i = 0; i < RUNS; i++) {
      row.cold.push(await measureLoad(browser, storageState, screen.path, { fresh: true }));
      process.stderr.write(".");
    }
    for (let i = 0; i < RUNS; i++) {
      row.warm.push(await measureLoad(browser, storageState, screen.path, { fresh: false }, { context: warmContext, page: warmPage }));
      process.stderr.write(".");
    }
    for (let i = 0; i < RUNS; i++) {
      try {
        const pair = await measureSpa(warmPage, screen.from, screen.path);
        row.spa.push(pair.first);
        row.spaRevisit.push(pair.revisit);
      } catch (err) {
        row.spaError = String(err.message || err);
        break;
      }
      process.stderr.write(".");
    }
    process.stderr.write("\n");

    for (const call of row.cold[0]?.calls ?? []) {
      const url = new URL(call.url, BASE);
      if (url.pathname.startsWith("/v1")) seenCalls.set(url.pathname + url.search, call.method);
    }
    row.apiCalls = (row.cold[0]?.calls ?? [])
      .filter((c) => new URL(c.url, BASE).pathname.startsWith("/v1"))
      .map((c) => ({ path: new URL(c.url, BASE).pathname + new URL(c.url, BASE).search, ms: c.end - c.start }));

    // A screen that fetches on a cold load and fetches nothing when it is
    // navigated into is not the same screen twice. Sometimes that is the point
    // — it reuses a resource the previous screen already loaded — and
    // sometimes it means the client took a different branch than the server
    // did, in which case the in-app number is not measuring the same thing and
    // should not be read beside the cold one.
    const spaCalls = (row.spa[0]?.calls ?? []).filter((c) => new URL(c.url, BASE).pathname.startsWith("/v1")).length;
    row.spaDivergent = row.apiCalls.length > 0 && spaCalls === 0;
    results.push(row);
  }

  await warmContext.close();
  await browser.close();

  // The API pass, over exactly the endpoints the console was seen to call.
  process.stderr.write("  /v1 endpoints ");
  const api = [];
  for (const [path] of seenCalls) {
    api.push({ path, ...(await sampleHttp(BASE + path, cookie, Math.max(RUNS, 10), "application/json")) });
    process.stderr.write(".");
  }
  process.stderr.write("\n");

  // And the boot documents, so a slow cold load can be attributed.
  const docs = [];
  for (const screen of list) {
    docs.push({ name: screen.name, ...(await sampleHttp(BASE + screen.path, cookie, Math.max(RUNS, 10), "text/html")) });
  }

  report(results, api, docs);

  if (JSON_OUT) {
    writeFileSync(JSON_OUT, JSON.stringify({ base: BASE, runs: RUNS, at: new Date().toISOString(), results, api, docs }, null, 2));
    console.log(`\nRaw samples → ${JSON_OUT}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Report                                                                      */
/* -------------------------------------------------------------------------- */

function table(rows, columns) {
  const widths = columns.map((c) => Math.max(c.label.length, ...rows.map((r) => String(c.get(r) ?? "—").length)));
  const line = (cells) =>
    cells.map((cell, i) => (columns[i].right ? String(cell).padStart(widths[i]) : String(cell).padEnd(widths[i]))).join("  ");
  console.log(line(columns.map((c) => c.label)));
  console.log(widths.map((w) => "─".repeat(w)).join("  "));
  for (const r of rows) console.log(line(columns.map((c) => c.get(r) ?? "—")));
}

function report(results, api, docs) {
  const pick = (runs, f) => stats(runs.map(f));

  console.log("\n\n════ Admin console — time to a readable screen (median of n runs, ms) ════\n");
  table(
    results.map((r) => {
      const cold = pick(r.cold, (x) => x.ready);
      const warm = pick(r.warm, (x) => x.ready);
      const spa = pick(r.spa, (x) => x.ready);
      const revisit = pick(r.spaRevisit, (x) => x.ready);
      return {
        name: r.name,
        cold: cold && ms(cold.median),
        coldMax: cold && ms(cold.max),
        warm: warm && ms(warm.median),
        spa: spa ? ms(spa.median) + (r.spaDivergent ? " *" : "") : r.spaError ? "n/a" : "—",
        spaMax: spa ? ms(spa.max) : "—",
        revisit: revisit ? ms(revisit.median) : "—",
        gain: cold && spa ? `${(cold.median / spa.median).toFixed(1)}×` : "—",
      };
    }),
    [
      { label: "screen", get: (r) => r.name },
      { label: "cold", get: (r) => r.cold, right: true },
      { label: "cold max", get: (r) => r.coldMax, right: true },
      { label: "warm", get: (r) => r.warm, right: true },
      { label: "in-app", get: (r) => r.spa, right: true },
      { label: "in-app max", get: (r) => r.spaMax, right: true },
      { label: "revisit", get: (r) => r.revisit, right: true },
      { label: "cold÷in-app", get: (r) => r.gain, right: true },
    ],
  );
  if (results.some((r) => r.spaDivergent)) {
    console.log(
      "\n  * fetched nothing on arrival though the cold load fetched — either it reuses what the\n" +
        "    previous screen loaded, or it rendered a different branch than the cold load did.\n" +
        "    Not comparable with the cold column until you know which.",
    );
  }

  console.log("\n\n════ Cold load, broken down (median, ms) ════\n");
  table(
    results.map((r) => ({
      name: r.name,
      ttfb: ms(pick(r.cold, (x) => x.ttfb)?.median),
      fcp: ms(pick(r.cold, (x) => x.fcp)?.median),
      dcl: ms(pick(r.cold, (x) => x.domContentLoaded)?.median),
      scripts: ms(pick(r.cold, (x) => x.scriptSpan)?.median),
      apiN: r.apiCalls?.length ?? 0,
      api: ms(pick(r.cold, (x) => (x.calls.length ? Math.max(...x.calls.map((c) => c.end)) - Math.min(...x.calls.map((c) => c.start)) : 0))?.median),
      ready: ms(pick(r.cold, (x) => x.ready)?.median),
      block: ms(pick(r.cold, (x) => x.longtasks.reduce((a, t) => a + t.duration, 0))?.median),
    })),
    [
      { label: "screen", get: (r) => r.name },
      { label: "TTFB", get: (r) => r.ttfb, right: true },
      { label: "FCP", get: (r) => r.fcp, right: true },
      { label: "DCL", get: (r) => r.dcl, right: true },
      { label: "modules", get: (r) => r.scripts, right: true },
      { label: "/v1 n", get: (r) => r.apiN, right: true },
      { label: "/v1 span", get: (r) => r.api, right: true },
      { label: "ready", get: (r) => r.ready, right: true },
      { label: "blocking", get: (r) => r.block, right: true },
    ],
  );

  console.log("\n\n════ Weight on a cold load (median, KB over the wire) ════\n");
  table(
    results.map((r) => ({
      name: r.name,
      doc: kb(pick(r.cold, (x) => x.documentBytes)?.median),
      docRaw: kb(pick(r.cold, (x) => x.documentDecoded)?.median),
      js: kb(pick(r.cold, (x) => x.scriptBytes)?.median),
      jsN: Math.round(pick(r.cold, (x) => x.scriptCount)?.median ?? 0),
      css: kb(pick(r.cold, (x) => x.styleBytes)?.median),
      total: kb(pick(r.cold, (x) => x.resourceBytes + x.documentBytes)?.median),
    })),
    [
      { label: "screen", get: (r) => r.name },
      { label: "document", get: (r) => r.doc, right: true },
      { label: "doc raw", get: (r) => r.docRaw, right: true },
      { label: "JS", get: (r) => r.js, right: true },
      { label: "modules", get: (r) => r.jsN, right: true },
      { label: "CSS", get: (r) => r.css, right: true },
      { label: "total", get: (r) => r.total, right: true },
    ],
  );

  console.log("\n\n════ Server time, no browser (ms, n≥10) ════\n");
  table(
    docs.map((d) => ({ ...d })),
    [
      { label: "boot document", get: (r) => r.name },
      { label: "status", get: (r) => r.status, right: true },
      { label: "median", get: (r) => ms(r.median), right: true },
      { label: "p95", get: (r) => ms(r.p95), right: true },
      { label: "max", get: (r) => ms(r.max), right: true },
      { label: "KB", get: (r) => kb(r.bytes), right: true },
    ],
  );

  console.log("");
  table(
    api.slice().sort((a, b) => b.median - a.median),
    [
      { label: "/v1 endpoint", get: (r) => r.path },
      { label: "status", get: (r) => r.status, right: true },
      { label: "median", get: (r) => ms(r.median), right: true },
      { label: "p95", get: (r) => ms(r.p95), right: true },
      { label: "max", get: (r) => ms(r.max), right: true },
      { label: "KB", get: (r) => kb(r.bytes), right: true },
    ],
  );

  if (VERBOSE) {
    console.log("\n\n════ What each screen fetches ════\n");
    for (const r of results) {
      console.log(`  ${r.name}`);
      for (const c of r.apiCalls ?? []) console.log(`    ${ms(c.ms).padStart(6)} ms  ${c.path}`);
      if (r.spaError) console.log(`    client navigation failed: ${r.spaError}`);
    }
  }

  const slowest = results
    .map((r) => ({ name: r.name, ready: stats(r.cold.map((x) => x.ready))?.median ?? 0 }))
    .sort((a, b) => b.ready - a.ready)[0];
  console.log(`\nSlowest cold screen: ${slowest.name} at ${ms(slowest.ready)} ms to readable.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
