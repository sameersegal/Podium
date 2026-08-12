#!/usr/bin/env node
/**
 * `podium` — the wire between an agent and a hosted Podium instance.
 *
 * This is deliberately a thin, generic HTTP client rather than a command per
 * task. The management API is 190 endpoints wide and the skills in this plugin
 * carry the recipes; what an agent needs from a tool is the plumbing it would
 * otherwise get wrong: reading the token out of a file without printing it,
 * putting an `Idempotency-Key` on every write because the runtime retries,
 * following `next_cursor` to the end of a list, and turning a typed domain
 * error into something readable instead of a stack trace.
 *
 * No dependencies, no build step: Node 18+ and the platform `fetch`.
 *
 *   podium whoami
 *   podium get /v1/events
 *   podium list /v1/proposals event_id=evt_… state=submitted --fields id,title,state
 *   podium post /v1/events/evt_…/rooms name="Hall A" capacity:=400
 *   podium patch /v1/proposals/prp_… title="A better title"
 *
 * Exit status is 0 only on a 2xx. Anything else is a non-zero exit with the
 * error body on stdout, so a caller can branch on it without parsing prose.
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import process from "node:process";

const VERSION = "1.0.0";

/* -------------------------------------------------------------------------- */
/* argv                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A flag/positional split that keeps `k=v` pairs as positionals. `--flag value`
 * and `--flag=value` both work; a flag with no value is a boolean.
 */
const BOOLEAN_FLAGS = new Set(["all", "quiet", "dry-run", "help", "version", "save", "no-idempotency", "include-pii-warning"]);

function parseArgv(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    if (BOOLEAN_FLAGS.has(body)) {
      flags[body] = true;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[body] = true;
    } else {
      flags[body] = next;
      i++;
    }
  }
  return { flags, positional };
}

/* -------------------------------------------------------------------------- */
/* configuration                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The token never appears on a command line by default. It lives in a file the
 * operator controls, because an argv is visible in `ps` and lands in shell
 * history, and this token is an org-wide credential.
 */
const TOKEN_KEYS = ["PODIUM_API_TOKEN", "PODIUM_TOKEN", "PODIUM_API_KEY"];
const URL_KEYS = ["PODIUM_URL", "PODIUM_BASE_URL"];

function parseEnvFile(path) {
  const out = {};
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const withoutExport = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const eq = withoutExport.indexOf("=");
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    let value = withoutExport.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Where a `.env` is looked for, in order, when `--env` is not given. */
function candidateEnvFiles() {
  return [
    process.env.PODIUM_ENV_FILE,
    join(process.cwd(), ".env"),
    join(process.cwd(), ".env.podium"),
    join(homedir(), ".podium", ".env"),
    join(homedir(), ".podium.env"),
  ].filter(Boolean);
}

function loadConfig(flags) {
  const explicit = flags.env ? [resolve(String(flags.env))] : candidateEnvFiles();
  let fileValues = {};
  let envFile = null;
  for (const candidate of explicit) {
    if (existsSync(candidate)) {
      const parsed = parseEnvFile(candidate);
      // The first file that actually carries a token wins; a project `.env`
      // with unrelated keys should not shadow `~/.podium/.env`.
      if (!envFile) {
        envFile = candidate;
        fileValues = parsed;
      }
      if (TOKEN_KEYS.some((k) => parsed[k])) {
        envFile = candidate;
        fileValues = parsed;
        break;
      }
    }
  }
  if (flags.env && !envFile) {
    fail(`No such env file: ${resolve(String(flags.env))}`);
  }

  const pick = (keys) => {
    for (const key of keys) {
      if (process.env[key]) return { value: process.env[key], from: `environment (${key})` };
    }
    for (const key of keys) {
      if (fileValues[key]) return { value: fileValues[key], from: `${envFile} (${key})` };
    }
    return { value: null, from: null };
  };

  const url = flags.url ? { value: String(flags.url), from: "--url" } : pick(URL_KEYS);
  const token = flags.token ? { value: String(flags.token), from: "--token" } : pick(TOKEN_KEYS);

  return {
    baseUrl: url.value ? String(url.value).replace(/\/+$/, "") : null,
    baseUrlFrom: url.from,
    token: token.value,
    tokenFrom: token.from,
    envFile,
  };
}

function requireConfig(config, { needsToken = true } = {}) {
  if (!config.baseUrl) {
    fail(
      "No instance URL. Pass --url https://podium.example.com, or set PODIUM_URL in the\n" +
        "environment or in a .env file (see --env).",
    );
  }
  if (needsToken && !config.token) {
    fail(
      "No API token. Put PODIUM_API_TOKEN=… in a .env file and pass --env <path>, or export it.\n" +
        `Looked in: ${candidateEnvFiles().join(", ")}\n` +
        "A token is created at /admin/api-keys on the instance, or with `podium bootstrap-key`.",
    );
  }
}

/* -------------------------------------------------------------------------- */
/* request                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * `k=v` is a string, `k:=v` is raw JSON. The second form is how an agent sends
 * a number, a boolean, or an array without a shell quoting puzzle:
 *
 *   capacity:=400   is_default:=true   scopes:='["events:read"]'
 */
function parsePairs(pairs) {
  const out = {};
  for (const pair of pairs) {
    const jsonEq = pair.indexOf(":=");
    if (jsonEq > 0) {
      const key = pair.slice(0, jsonEq);
      const raw = pair.slice(jsonEq + 2);
      try {
        out[key] = JSON.parse(raw);
      } catch {
        fail(`Not valid JSON for ${key}:= — ${raw}`);
      }
      continue;
    }
    const eq = pair.indexOf("=");
    if (eq <= 0) fail(`Expected key=value or key:=json, got: ${pair}`);
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

function bodyFrom(flags, pairs) {
  if (flags.data !== undefined) {
    const raw = String(flags.data);
    const text = raw.startsWith("@") ? readFileSync(resolve(raw.slice(1)), "utf8") : raw;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      fail(`--data is not valid JSON: ${err.message}`);
    }
    return { ...parsed, ...parsePairs(pairs) };
  }
  if (!pairs.length) return null;
  return parsePairs(pairs);
}

function urlFor(config, path, query) {
  const url = new URL(path.startsWith("http") ? path : config.baseUrl + (path.startsWith("/") ? path : `/${path}`));
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    url.searchParams.set(key, String(value));
  }
  return url;
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * One request, with retries that are only safe because of the idempotency key:
 * INV-09-7 says a repeat within 24h replays the stored response and performs no
 * new writes, so a retried `POST` cannot double-book a room.
 */
async function request(config, method, path, { query, body, flags = {} } = {}) {
  const url = urlFor(config, path, query);
  const headers = {
    accept: "application/json",
    "user-agent": `podium-cli/${VERSION}`,
  };
  if (config.token) headers.authorization = `Bearer ${config.token}`;
  if (config.cookie) headers.cookie = config.cookie;

  const mutating = method !== "GET" && method !== "HEAD";
  if (mutating && !flags["no-idempotency"]) {
    headers["idempotency-key"] = String(flags["idempotency-key"] ?? randomUUID());
  }
  let payload;
  if (body !== null && body !== undefined) {
    payload = JSON.stringify(body);
    headers["content-type"] = "application/json";
  }

  if (flags["dry-run"]) {
    return {
      dryRun: true,
      status: 0,
      body: { method, url: url.toString(), headers: { ...headers, authorization: config.token ? "Bearer ***" : undefined }, body: body ?? null },
    };
  }

  const attempts = Number(flags.retry ?? 2) + 1;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let res;
    try {
      res = await fetch(url, { method, headers, body: payload, redirect: "manual" });
    } catch (err) {
      lastError = err;
      if (attempt === attempts) fail(`Could not reach ${url.origin}: ${err.message}`);
      await sleep(backoff(attempt));
      continue;
    }
    if (RETRYABLE.has(res.status) && attempt < attempts) {
      await sleep(backoff(attempt, res.headers.get("retry-after")));
      continue;
    }
    return await readResponse(res);
  }
  fail(`Could not reach ${url.origin}: ${lastError?.message ?? "unknown error"}`);
}

async function readResponse(res) {
  const text = await res.text();
  let parsed = null;
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("json") && text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  return {
    status: res.status,
    ok: res.status >= 200 && res.status < 300,
    body: parsed,
    text,
    headers: res.headers,
    replayed: res.headers.get("idempotent-replay") === "true",
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backoff = (attempt, retryAfter) => (retryAfter ? Number(retryAfter) * 1000 : Math.min(8000, 250 * 2 ** attempt));

/* -------------------------------------------------------------------------- */
/* output                                                                     */
/* -------------------------------------------------------------------------- */

function fail(message) {
  process.stderr.write(`podium: ${message}\n`);
  process.exit(2);
}

function note(message) {
  process.stderr.write(`${message}\n`);
}

/** Project a list of objects down to named fields — a list of 300 proposals is
 *  worth reading as five columns, not as 300 full records. */
function project(rows, fieldSpec) {
  const fields = String(fieldSpec)
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);
  return rows.map((row) => {
    const out = {};
    for (const field of fields) out[field] = dig(row, field);
    return out;
  });
}

function dig(obj, path) {
  return path.split(".").reduce((acc, key) => (acc === null || acc === undefined ? undefined : acc[key]), obj);
}

/**
 * Print a result and choose the exit code. A domain error is printed as itself:
 * the code, the message, the invariant it violated and the field errors are the
 * whole diagnosis, and reformatting them loses the invariant.
 */
function emit(result, flags) {
  if (result.dryRun) {
    process.stdout.write(`${JSON.stringify(result.body, null, 2)}\n`);
    return 0;
  }
  if (result.replayed && !flags.quiet) {
    note("(idempotent replay — this exact request was already made in the last 24h; nothing was written again)");
  }

  let payload = result.body;
  if (payload === null && result.text) {
    process.stdout.write(`${result.text}\n`);
    return result.ok ? 0 : 1;
  }

  if (result.ok && flags.fields && payload) {
    const rows = Array.isArray(payload) ? payload : Array.isArray(payload.data) ? payload.data : null;
    if (rows) {
      const projected = project(rows, flags.fields);
      payload = Array.isArray(payload) ? projected : { ...payload, data: projected };
    }
  }

  if (payload === null && result.status === 204) {
    if (!flags.quiet) note("204 No Content — done.");
    return 0;
  }

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);

  if (!result.ok) {
    const code = payload?.error;
    const invariant = payload?.invariant;
    if (!flags.quiet) {
      note(`HTTP ${result.status}${code ? ` ${code}` : ""}${invariant ? ` (${invariant})` : ""}`);
      note(hintFor(result.status, code));
    }
    return 1;
  }
  return 0;
}

function hintFor(status, code) {
  if (status === 401) return "The token is missing, revoked or expired. Check PODIUM_API_TOKEN, or mint a new key at /admin/api-keys.";
  if (status === 403) return "The token authenticated but its scopes do not cover this. `podium whoami` lists them.";
  if (status === 404) return "Wrong id, or an id belonging to another event this key cannot see (event_ids on the key restricts it).";
  if (status === 409 && code === "version_conflict") return "Someone else wrote first. Re-read the record, merge, and retry with the current row_version.";
  if (status === 422) return "The request reached the domain and was refused by a rule. `invariant` names it; docs/domain/ explains it.";
  if (status === 429) return "Throttled. Back off and retry — the same Idempotency-Key makes that safe.";
  return "";
}

/* -------------------------------------------------------------------------- */
/* commands                                                                   */
/* -------------------------------------------------------------------------- */

async function cmdRequest(method, config, positional, flags) {
  const path = positional[0];
  if (!path) fail(`Usage: podium ${method.toLowerCase()} <path> [key=value ...]`);
  const pairs = positional.slice(1);
  const isRead = method === "GET" || method === "DELETE";
  const result = await request(config, method, path, {
    query: isRead ? parsePairs(pairs) : undefined,
    body: isRead ? null : bodyFrom(flags, pairs),
    flags,
  });
  return emit(result, flags);
}

/**
 * Follow `next_cursor` to the end. Offsets over a growing proposal table
 * produce duplicates and gaps mid-round (09), which is why the API is
 * cursor-paginated and why walking it belongs here rather than in a recipe
 * every skill would have to repeat.
 */
async function cmdList(config, positional, flags) {
  const path = positional[0];
  if (!path) fail("Usage: podium list <path> [key=value ...]");
  const query = parsePairs(positional.slice(1));
  const max = Number(flags.max ?? 1000);
  if (!query.limit) query.limit = String(Math.min(100, max));

  const rows = [];
  let cursor = null;
  let pages = 0;
  while (rows.length < max) {
    const result = await request(config, "GET", path, { query: { ...query, cursor }, flags });
    if (!result.ok) return emit(result, flags);
    const payload = result.body;
    const page = Array.isArray(payload) ? payload : (payload?.data ?? null);
    if (page === null) {
      // Not a list endpoint. Print what came back rather than pretending.
      return emit(result, flags);
    }
    rows.push(...page);
    pages++;
    cursor = Array.isArray(payload) ? null : (payload.next_cursor ?? null);
    if (!cursor) break;
    if (pages > 200) {
      note("Stopped after 200 pages — narrow the query.");
      break;
    }
  }
  const trimmed = rows.slice(0, max);
  const truncated = rows.length > trimmed.length || (rows.length === max && cursor);
  const out = flags.fields ? project(trimmed, flags.fields) : trimmed;
  process.stdout.write(`${JSON.stringify({ count: trimmed.length, truncated: Boolean(truncated), data: out }, null, 2)}\n`);
  if (truncated && !flags.quiet) note(`Stopped at --max ${max}; there are more. Raise --max or narrow the query.`);
  return 0;
}

/**
 * What can this token actually do? Scopes are not readable from the token, so
 * this asks the instance: the key's own record if it may read it, and a probe
 * of each surface otherwise. Getting this wrong is the single most common way
 * an agent wastes a turn — a 403 four calls into a recipe.
 */
async function cmdWhoami(config, flags) {
  const out = { instance: config.baseUrl, token_source: config.tokenFrom, env_file: config.envFile };

  const keys = await request(config, "GET", "/v1/api-keys", { flags });
  if (keys.status === 401) {
    process.stdout.write(`${JSON.stringify({ ...out, authenticated: false }, null, 2)}\n`);
    note("HTTP 401 — the token is not valid on this instance.");
    return 1;
  }
  out.authenticated = true;

  if (keys.ok && Array.isArray(keys.body)) {
    // A key that may list keys cannot tell which row is itself — the secret is
    // hashed and only the prefix is stored. Match on the prefix of the token
    // we hold, which is exactly how the admin screen identifies a key.
    const prefix = String(config.token).slice(0, 8);
    const self = keys.body.find((k) => k.prefix === prefix);
    if (self) {
      out.key = { id: self.id, name: self.name, prefix: self.prefix, scopes: self.scopes, event_ids: self.event_ids, expires_at: self.expires_at, revoked_at: self.revoked_at };
    }
  }

  const events = await request(config, "GET", "/v1/events", { query: { limit: 100 }, flags });
  const eventRows = events.ok ? (events.body?.data ?? []) : [];
  out.events = events.ok
    ? eventRows.map((e) => ({ id: e.id, name: e.name, slug: e.slug, status: e.status, timezone: e.timezone, starts_on: e.starts_on }))
    : `unavailable (HTTP ${events.status})`;

  // Probe the surfaces rather than infer from scopes. 200 means reachable;
  // 401/403 means not; anything else (a 422 for a missing `event_id`) means
  // the guard let us through and the handler wanted better arguments — which
  // is a "yes" for permission purposes but should not be reported as a clean
  // read.
  const eventId = eventRows[0]?.id;
  const rounds = eventId ? await request(config, "GET", "/v1/rounds", { query: { event_id: eventId, limit: 1 }, flags }) : null;
  const roundId = rounds?.ok ? (rounds.body?.data?.[0]?.id ?? null) : null;
  const probes = [
    ["proposals:read", "/v1/proposals", eventId ? { event_id: eventId, limit: 1 } : { limit: 1 }],
    // `/v1/reviews` insists on a round or a proposal before it will look at
    // permission, so probing it needs a round id first.
    ["reviews:read", roundId ? "/v1/reviews" : null, { round_id: roundId, limit: 1 }],
    ["sessions:read", "/v1/sessions", eventId ? { event_id: eventId, limit: 1 } : { limit: 1 }],
    ["schedule:read", eventId ? `/v1/events/${eventId}/schedule` : null, {}],
    ["sponsors:read", "/v1/sponsors", { limit: 1 }],
    ["tasks:read", "/v1/tasks", { limit: 1 }],
  ];
  const reachable = { "events:read": events.ok ? "yes" : events.status === 403 || events.status === 401 ? "no" : `unknown (HTTP ${events.status})` };
  for (const [label, path, query] of probes) {
    if (!path) continue;
    const res = await request(config, "GET", path, { query, flags });
    reachable[label] = res.ok ? "yes" : res.status === 403 || res.status === 401 ? "no" : `unknown (HTTP ${res.status})`;
  }
  out.reachable = reachable;

  // The trap worth naming out loud. An API key's scopes are mapped onto a role
  // — `admin` if it holds any `:write` scope, `viewer` otherwise — and `viewer`
  // carries no read in the authorization matrix. So a key granted only `:read`
  // scopes authenticates fine and is then refused every management read, which
  // reads like a broken token and is not one.
  const scopes = out.key?.scopes ?? null;
  const readOnly = scopes ? !scopes.some((s) => s.endsWith(":write") || s === "schedule:publish") : null;
  // "no probe succeeded" rather than "every probe said no": a 422 for a missing
  // argument is not evidence of permission either way, and treating it as one
  // is how the diagnosis below silently stops firing.
  const nothingReachable = !Object.values(reachable).some((v) => v === "yes");
  if (nothingReachable && (readOnly === true || readOnly === null)) {
    out.diagnosis =
      "Authenticated, but every management read is refused. An API key with only `:read` scopes " +
      "authenticates as a `viewer`, and `viewer` has no read permission in the authorization matrix — " +
      "so a read-only key is refused everywhere except /v1/public/…. Give the key at least one `:write` " +
      "scope (it then authenticates as `admin`), or read the public surface instead.";
  }
  if (!out.key) {
    out.note = "This key cannot read its own record (that needs org.configure), so `reachable` was probed rather than listed from `scopes`.";
  }

  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  return 0;
}

/**
 * Trade an email and password for a scoped API key.
 *
 * Only useful where password sign-in is on — R23 turns it off in production
 * config, and a hosted instance using invitation links will refuse this. It
 * exists because the alternative on a fresh local or self-hosted instance is
 * "open a browser, click through /admin/api-keys, copy a secret", which an
 * agent cannot do.
 */
async function cmdBootstrapKey(config, flags) {
  const email = flags.email && String(flags.email);
  const password = flags.password && String(flags.password);
  if (!email || !password) fail("Usage: podium bootstrap-key --email <email> --password <password> [--scopes a,b] [--name N] [--save]");

  const login = await request({ ...config, token: null }, "POST", "/login", { body: { email, password }, flags: { ...flags, "no-idempotency": true } });
  if (login.status !== 303 && login.status !== 302 && !login.ok) {
    process.stdout.write(`${JSON.stringify(login.body ?? { status: login.status }, null, 2)}\n`);
    note(login.status === 403 ? "Password sign-in is disabled on this instance. Create the key at /admin/api-keys instead." : `Sign-in failed (HTTP ${login.status}).`);
    return 1;
  }
  const setCookie = login.headers.get("set-cookie") ?? "";
  const session = /podium_session=([^;]+)/.exec(setCookie)?.[1];
  if (!session) {
    note("Signed in but no session cookie came back — cannot continue.");
    return 1;
  }

  const scopes = String(flags.scopes ?? DEFAULT_SCOPES.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
  const created = await request(
    { ...config, token: null, cookie: `podium_session=${session}` },
    "POST",
    "/v1/api-keys",
    { body: { name: String(flags.name ?? "agent"), scopes, event_ids: flags.event ? [String(flags.event)] : [] }, flags },
  );
  if (!created.ok) return emit(created, flags);

  const secret = created.body.secret;
  if (flags.save) {
    const target = flags.env ? resolve(String(flags.env)) : join(process.cwd(), ".env");
    appendFileSync(target, `\nPODIUM_URL=${config.baseUrl}\nPODIUM_API_TOKEN=${secret}\n`, { mode: 0o600 });
    note(`Wrote PODIUM_URL and PODIUM_API_TOKEN to ${target}. Keep it out of version control.`);
    process.stdout.write(`${JSON.stringify({ id: created.body.id, name: created.body.name, prefix: created.body.prefix, scopes: created.body.scopes, saved_to: target }, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(`${JSON.stringify(created.body, null, 2)}\n`);
  note("The secret above is shown once and never stored (INV-09-1). Put it in a .env file now.");
  return 0;
}

const DEFAULT_SCOPES = [
  "events:read", "events:write",
  "proposals:read", "proposals:write",
  "reviews:read", "reviews:write",
  "decisions:read", "decisions:write",
  "sessions:read", "sessions:write",
  "speakers:read", "speakers:write",
  "sponsors:read", "sponsors:write",
  "entitlements:read", "entitlements:write",
  "tasks:read", "tasks:write",
  "schedule:read", "schedule:publish",
];

/**
 * Fetch a file rather than a JSON document — an export lands as an `Asset`, and
 * the CSV an organizer actually wants is behind `/files/:assetId/download`.
 * Writing it through the JSON printer would corrupt it.
 */
async function cmdDownload(config, positional, flags) {
  const path = positional[0];
  if (!path) fail("Usage: podium download <path> --out <file>");
  const out = flags.out ?? flags.o;
  if (!out) fail("podium download needs --out <file>.");
  const url = urlFor(config, path, parsePairs(positional.slice(1)));
  const res = await fetch(url, { headers: { authorization: `Bearer ${config.token}`, "user-agent": `podium-cli/${VERSION}` } });
  if (!res.ok) {
    const body = await res.text();
    process.stdout.write(`${body}\n`);
    note(`HTTP ${res.status} — ${hintFor(res.status)}`);
    return 1;
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  writeFileSync(resolve(String(out)), buffer);
  process.stdout.write(
    `${JSON.stringify({ saved_to: resolve(String(out)), bytes: buffer.length, content_type: res.headers.get("content-type") }, null, 2)}\n`,
  );
  return 0;
}

/** Grep the shipped endpoint catalogue without leaving the tool. */
function cmdEndpoints(positional) {
  const path = join(import.meta.dirname ?? new URL(".", import.meta.url).pathname, "..", "skills", "podium-api", "reference", "endpoints.md");
  if (!existsSync(path)) fail(`Endpoint catalogue not found at ${path}`);
  const lines = readFileSync(path, "utf8").split("\n");
  const needle = positional.join(" ").toLowerCase();
  const matched = needle ? lines.filter((l) => l.toLowerCase().includes(needle)) : lines;
  process.stdout.write(`${matched.join("\n")}\n`);
  if (needle && !matched.length) note(`Nothing matching "${needle}". Try: events, proposals, reviews, decisions, schedule, tasks, sponsors, campaigns.`);
  return 0;
}

const HELP = `podium ${VERSION} — operate a Podium instance over its management API

  podium whoami                              what this token is and what it can reach
  podium get <path> [k=v ...]                GET; pairs become query parameters
  podium list <path> [k=v ...]               GET, following next_cursor to the end
  podium post <path> [k=v|k:=json ...]       POST with a JSON body
  podium patch <path> [k=v|k:=json ...]      PATCH with a JSON body
  podium delete <path> [k=v ...]             DELETE
  podium download <path> --out <file>        save a file (an export's CSV, an upload)
  podium endpoints [filter]                  grep the endpoint catalogue
  podium bootstrap-key --email --password    mint an API key where password login is on

Connection
  --url <base>          instance URL; else PODIUM_URL, else a .env file
  --env <path>          .env file holding PODIUM_API_TOKEN (default: ./.env, ~/.podium/.env)
  --token <secret>      last resort — argv is visible in ps and shell history

Request
  k=v                   string field (query on GET/DELETE, body on POST/PATCH)
  k:=<json>             raw JSON field: capacity:=400, tags:='["ai"]'
  --data '<json>'       whole body as JSON; --data @file.json to read a file
  --idempotency-key K   pin the key instead of generating one (INV-09-7)
  --no-idempotency      omit it entirely
  --retry N             retries on 429/5xx (default 2)
  --dry-run             print the request, send nothing

Output
  --fields a,b,c        project list rows down to named fields (dots allowed)
  --max N               list: stop after N rows (default 1000)
  --quiet               body only, no notes on stderr

Exit status is 0 on 2xx, 1 on an HTTP error, 2 on a usage or connection problem.
`;

/* -------------------------------------------------------------------------- */

async function main() {
  const { flags, positional } = parseArgv(process.argv.slice(2));
  const command = positional.shift();

  if (flags.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (!command || flags.help || command === "help") {
    process.stdout.write(HELP);
    return command ? 0 : 2;
  }
  if (command === "endpoints") return cmdEndpoints(positional);

  const config = loadConfig(flags);

  switch (command) {
    case "whoami":
      requireConfig(config);
      return cmdWhoami(config, flags);
    case "bootstrap-key":
      requireConfig(config, { needsToken: false });
      return cmdBootstrapKey(config, flags);
    case "get":
      requireConfig(config);
      return cmdRequest("GET", config, positional, flags);
    case "list":
      requireConfig(config);
      return cmdList(config, positional, flags);
    case "post":
      requireConfig(config);
      return cmdRequest("POST", config, positional, flags);
    case "patch":
      requireConfig(config);
      return cmdRequest("PATCH", config, positional, flags);
    case "put":
      requireConfig(config);
      return cmdRequest("PUT", config, positional, flags);
    case "delete":
      requireConfig(config);
      return cmdRequest("DELETE", config, positional, flags);
    case "download":
      requireConfig(config);
      return cmdDownload(config, positional, flags);
    default:
      fail(`Unknown command: ${command}\n\n${HELP}`);
  }
}

main().then(
  (code) => process.exit(code ?? 0),
  (err) => fail(err?.stack ?? String(err)),
);
