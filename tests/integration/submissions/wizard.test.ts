import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "@podiumstack/domain/identity/credentials.js";

/**
 * 04 — Submissions: the submitter portal end to end — sign in, create a
 * draft, save a step, resume it, submit — against real local D1 bindings
 * (implementer.md, D: "real bindings via vitest-pool-workers").
 */

const ORG = "org_wiz";
const EVENT = "evt_wiz";
const TRACK = "trk_wiz";
const FORMAT = "fmt_wiz";
const CFP = "cfp_wiz";
const FORM = "frm_wiz";
const STEP_TALK = "stp_wiz_talk";
const STEP_REVIEW = "stp_wiz_review";

const SPEAKER = "per_wiz_speaker";
const SPEAKER_EMAIL = "wiz-speaker@example.com";
const SPEAKER_PASSWORD = "wizard-speaker-password";

const OTHER_SPEAKER = "per_wiz_speaker2";
const OTHER_SPEAKER_EMAIL = "wiz-speaker2@example.com";
const OTHER_SPEAKER_PASSWORD = "wizard-speaker2-password";

const OWNER = "per_wiz_owner";
const OWNER_EMAIL = "wiz-owner@example.com";
const OWNER_PASSWORD = "wizard-owner-password";

const REVIEWER = "per_wiz_reviewer";
const REVIEWER_EMAIL = "wiz-reviewer@example.com";
const REVIEWER_PASSWORD = "wizard-reviewer-password";

function iso(daysFromNow: number): string {
  return new Date(Date.now() + daysFromNow * 86_400_000).toISOString();
}

async function run(sql: string, params: unknown[] = []): Promise<void> {
  await env.DB.prepare(sql).bind(...params).run();
}

async function seedPerson(id: string, email: string, fullName: string, password: string): Promise<void> {
  const now = new Date().toISOString();
  await run(
    "INSERT OR IGNORE INTO person (id, email, full_name, status, is_placeholder, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
    [id, email, fullName, "active", 0, now, now],
  );
  await run(
    "INSERT OR IGNORE INTO auth_identity (id, person_id, provider, subject, credential_hash, credential_updated_at, email_at_provider, created_at) VALUES (?,?,?,?,?,?,?,?)",
    [`aid_${id}`, id, "password", email, hashPassword(password), now, email, now],
  );
}

async function seed(): Promise<void> {
  const now = new Date().toISOString();

  await run(
    "INSERT OR IGNORE INTO organization (id, name, slug, default_timezone, contact_email, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    [ORG, "Wizard Org", "wizard-org", "UTC", "a@b.example", JSON.stringify({ auth: { password_login_enabled: true } }), now, now],
  );

  await run(
    "INSERT OR IGNORE INTO event (id, name, slug, timezone, starts_on, ends_on, mode, status, visibility, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    [EVENT, "Wizard Conf 2027", "wizard-conf", "UTC", "2027-06-01", "2027-06-03", "in_person", "active", "public", "{}", now, now],
  );

  await run("INSERT OR IGNORE INTO track (id, event_id, name, slug, sort_order, is_public) VALUES (?,?,?,?,?,?)", [TRACK, EVENT, "Agents", "agents", 0, 1]);

  await run(
    "INSERT OR IGNORE INTO session_format (id, event_id, name, slug, default_duration_minutes, max_speakers, eligible_origins, requires_review, requires_recording_consent, capacity_policy, sort_order, is_public) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    [FORMAT, EVENT, "Talk", "talk", 30, 1, JSON.stringify(["cfp"]), 1, 0, "open", 0, 1],
  );

  await run(
    `INSERT OR IGNORE INTO call_for_proposals
       (id, event_id, name, slug, audience, opens_at, closes_at, grace_period_minutes, late_submission_policy,
        allow_edit_after_submit, withdraw_allowed_until, notify_on_submit, published_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [CFP, EVENT, "Main CFP", "main", "public", iso(-10), iso(30), 0, "reject", 1, "always", 1, iso(-11), now, now],
  );

  await run("INSERT OR IGNORE INTO submission_form (id, cfp_id, version, status, published_at, created_at) VALUES (?,?,?,?,?,?)", [FORM, CFP, 1, "published", iso(-11), now]);
  await run("UPDATE call_for_proposals SET active_form_id = ? WHERE id = ?", [FORM, CFP]);

  await run("INSERT OR IGNORE INTO form_step (id, form_id, key, title, description, sort_order, is_optional) VALUES (?,?,?,?,?,?,?)", [
    STEP_TALK,
    FORM,
    "the-talk",
    "About your talk",
    "The basics.",
    0,
    0,
  ]);
  await run("INSERT OR IGNORE INTO form_step (id, form_id, key, title, description, sort_order, is_optional) VALUES (?,?,?,?,?,?,?)", [
    STEP_REVIEW,
    FORM,
    "review-and-submit",
    "Review and submit",
    "Check everything.",
    1,
    0,
  ]);

  const fields: [string, string, string, string, boolean, string][] = [
    ["fld_wiz_speakers", "speakers", "Speakers", "speaker_list", true, "speakers"],
    ["fld_wiz_title", "title", "Title", "short_text", true, "title"],
    ["fld_wiz_abstract", "abstract", "Abstract", "long_text", true, "abstract"],
    ["fld_wiz_track", "track", "Track", "track_picker", true, "track"],
    ["fld_wiz_format", "format", "Format", "format_picker", true, "format"],
  ];
  for (let i = 0; i < fields.length; i++) {
    const [id, key, label, type, required, mapsTo] = fields[i];
    await run(
      "INSERT OR IGNORE INTO form_field (id, step_id, form_id, key, label, type, is_required, maps_to, audience, pii, sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      [id, STEP_TALK, FORM, key, label, type, required ? 1 : 0, mapsTo, "public", 0, i],
    );
  }

  await run("INSERT OR IGNORE INTO cfp_track_option (id, cfp_id, track_id, is_available, sort_order) VALUES (?,?,?,?,?)", ["cto_wiz", CFP, TRACK, 1, 0]);
  await run("INSERT OR IGNORE INTO cfp_format_option (id, cfp_id, session_format_id, is_available, sort_order) VALUES (?,?,?,?,?)", ["cfo_wiz", CFP, FORMAT, 1, 0]);

  await seedPerson(SPEAKER, SPEAKER_EMAIL, "Wiz Speaker", SPEAKER_PASSWORD);
  await seedPerson(OTHER_SPEAKER, OTHER_SPEAKER_EMAIL, "Other Speaker", OTHER_SPEAKER_PASSWORD);
  await seedPerson(OWNER, OWNER_EMAIL, "Wiz Owner", OWNER_PASSWORD);
  await seedPerson(REVIEWER, REVIEWER_EMAIL, "Wiz Reviewer", REVIEWER_PASSWORD);
  await run("INSERT OR IGNORE INTO role_grant (id, person_id, role, scope_type, scope_id, granted_by_person_id, granted_at) VALUES (?,?,?,?,?,?,?)", [
    "rgr_wiz_owner",
    OWNER,
    "owner",
    "org",
    ORG,
    OWNER,
    now,
  ]);
  await run("INSERT OR IGNORE INTO role_grant (id, person_id, role, scope_type, scope_id, granted_by_person_id, granted_at) VALUES (?,?,?,?,?,?,?)", [
    "rgr_wiz_reviewer",
    REVIEWER,
    "reviewer",
    "event",
    EVENT,
    OWNER,
    now,
  ]);
}

async function signIn(email: string, password: string): Promise<string> {
  const res = await SELF.fetch("http://localhost/login", {
    method: "POST",
    body: new URLSearchParams({ email, password }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    redirect: "manual",
  });
  expect(res.status).toBe(303);
  const setCookie = res.headers.get("set-cookie") ?? "";
  const match = /podium_session=([^;]+)/.exec(setCookie);
  if (!match) throw new Error(`Sign-in did not set a session cookie: ${setCookie}`);
  return `podium_session=${match[1]}`;
}

function withCookie(cookie: string, init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...(init.headers ?? {}), cookie } };
}

const FORM_HEADERS = { "content-type": "application/x-www-form-urlencoded" };

describe("the submitter wizard (04)", () => {
  let cookie: string;
  let proposalId: string;

  beforeAll(async () => {
    await seed();
    cookie = await signIn(SPEAKER_EMAIL, SPEAKER_PASSWORD);
  });

  it("redirects an anonymous visitor to /login?next=", async () => {
    const res = await SELF.fetch("http://localhost/portal", { redirect: "manual" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login?next=%2Fportal");
  });

  it("lists the open call on the new-proposal picker", async () => {
    const res = await SELF.fetch("http://localhost/portal/proposals/new", withCookie(cookie));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Main CFP");
  });

  it("creates a draft and lands on the wizard's first step", async () => {
    const res = await SELF.fetch(
      "http://localhost/portal/proposals/new",
      withCookie(cookie, { method: "POST", body: new URLSearchParams({ cfp_id: CFP }), headers: FORM_HEADERS, redirect: "manual" }),
    );
    expect(res.status).toBe(303);
    const location = res.headers.get("location")!;
    expect(location).toMatch(/\/portal\/proposals\/prp_[0-9A-Za-z]+\/step\/the-talk/);
    proposalId = location.match(/\/portal\/proposals\/(prp_[0-9A-Za-z]+)\//)![1];

    const row = await env.DB.prepare("SELECT status, form_id FROM proposal WHERE id = ?").bind(proposalId).first<{ status: string; form_id: string }>();
    expect(row?.status).toBe("draft");
    expect(row?.form_id).toBe(FORM);

    // The primary speaker is credited automatically, and the `speakers`
    // answer is kept in step with that roster immediately (04, "Why content
    // is both promoted columns and answers").
    const speakerCount = await env.DB.prepare("SELECT COUNT(*) AS n FROM proposal_speaker WHERE proposal_id = ?").bind(proposalId).first<{ n: number }>();
    expect(speakerCount?.n).toBe(1);
    const answer = await env.DB.prepare("SELECT value FROM proposal_answer WHERE proposal_id = ? AND field_key = 'speakers'").bind(proposalId).first<{ value: string }>();
    expect(JSON.parse(answer!.value)).toHaveLength(1);
  });

  it("renders the wizard step with a step indicator and one control per field", async () => {
    const res = await SELF.fetch(`http://localhost/portal/proposals/${proposalId}/step/the-talk`, withCookie(cookie));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('class="steps"');
    expect(body).toContain('name="answer.title"');
    expect(body).toContain('name="answer.abstract"');
    expect(body).toContain('name="answer.track"');
    expect(body).toContain('name="answer.format"');
  });

  /**
   * HTML has no nested forms: a browser meeting an inner `<form>` closes the
   * outer one and orphans every control after it. The speaker roster posts to
   * its own route, so it used to open a form inside the step's form — which
   * put the rest of the step, "Save draft" and "Save and continue" outside any
   * form at all, and made the wizard impossible to complete in a browser while
   * every server-side test kept passing.
   */
  it("keeps the step's controls inside one form — the roster's own posts never nest inside it", async () => {
    const res = await SELF.fetch(`http://localhost/portal/proposals/${proposalId}/step/your-details`, withCookie(cookie));
    const body = await res.text();

    let depth = 0;
    let nested = 0;
    for (const m of body.matchAll(/<\/?form\b/gi)) {
      if (m[0][1] === "/") depth = Math.max(0, depth - 1);
      else {
        if (depth > 0) nested++;
        depth++;
      }
    }
    expect(nested).toBe(0);

    // The roster's controls are still on the page, associated by `form=` id to
    // form elements that sit outside the step form.
    expect(body).toContain('form="add-cospeaker"');
    expect(body).toContain('id="add-cospeaker"');
  });

  it("saves a partial step with 'Save draft' — autosave runs no validation", async () => {
    const res = await SELF.fetch(
      `http://localhost/portal/proposals/${proposalId}/step/the-talk`,
      withCookie(cookie, {
        method: "POST",
        body: new URLSearchParams({ "answer.title": "My great talk", client_revision: "0", save: "1" }),
        headers: FORM_HEADERS,
        redirect: "manual",
      }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/portal/proposals/${proposalId}/step/the-talk`);

    const row = await env.DB.prepare("SELECT title FROM proposal WHERE id = ?").bind(proposalId).first<{ title: string }>();
    expect(row?.title).toBe("My great talk");
  });

  it("resumes the draft with the saved answer prefilled", async () => {
    const res = await SELF.fetch(`http://localhost/portal/proposals/${proposalId}/step/the-talk`, withCookie(cookie));
    const body = await res.text();
    expect(body).toContain("My great talk");
  });

  it("shows the draft on the dashboard with a plain-language next action", async () => {
    const res = await SELF.fetch("http://localhost/portal", withCookie(cookie));
    const body = await res.text();
    expect(body).toContain("My great talk");
    expect(body).toMatch(/Finish and submit|complete/);
  });

  it("submitting with a required field empty returns errors keyed by field", async () => {
    const res = await SELF.fetch(`http://localhost/portal/proposals/${proposalId}/submit`, withCookie(cookie, { method: "POST", redirect: "manual" }));
    expect(res.status).toBe(422);
    const body = await res.text();
    // `abstract`, `track` and `format` were never answered.
    expect(body).toContain("Abstract is required");
    expect(body).toContain("Track is required");
    expect(body).toContain("Format is required");

    const row = await env.DB.prepare("SELECT status FROM proposal WHERE id = ?").bind(proposalId).first<{ status: string }>();
    expect(row?.status).toBe("draft");
  });

  it("fills in the rest and advances to the review step, saving en route", async () => {
    const res = await SELF.fetch(
      `http://localhost/portal/proposals/${proposalId}/step/the-talk`,
      withCookie(cookie, {
        method: "POST",
        body: new URLSearchParams({
          "answer.title": "My great talk",
          "answer.abstract": "A very good abstract about the thing.",
          "answer.track": TRACK,
          "answer.format": FORMAT,
          client_revision: "1",
          next_step_key: "review-and-submit",
          next: "1",
        }),
        headers: FORM_HEADERS,
        redirect: "manual",
      }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/portal/proposals/${proposalId}/step/review-and-submit`);

    const review = await SELF.fetch(`http://localhost/portal/proposals/${proposalId}/step/review-and-submit`, withCookie(cookie));
    const body = await review.text();
    expect(body).toContain("Review your answers");
    expect(body).toContain("My great talk");
  });

  it("submits once every rule passes, and the proposal moves to submitted", async () => {
    const res = await SELF.fetch(`http://localhost/portal/proposals/${proposalId}/submit`, withCookie(cookie, { method: "POST", redirect: "manual" }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/portal/proposals/${proposalId}`);

    const row = await env.DB.prepare("SELECT status, submitted_at FROM proposal WHERE id = ?").bind(proposalId).first<{ status: string; submitted_at: string | null }>();
    expect(row?.status).toBe("submitted");
    expect(row?.submitted_at).toBeTruthy();
  });

  it("edits a submitted proposal in place: the round trip through draft ends back at submitted", async () => {
    const res = await SELF.fetch(
      `http://localhost/portal/proposals/${proposalId}/step/the-talk`,
      withCookie(cookie, {
        method: "POST",
        body: new URLSearchParams({
          "answer.title": "My great talk",
          "answer.abstract": "A very good abstract about the thing. Updated: now includes 2026 benchmark data.",
          "answer.track": TRACK,
          "answer.format": FORMAT,
          client_revision: "2",
          save: "1",
        }),
        headers: FORM_HEADERS,
        redirect: "manual",
      }),
    );
    expect(res.status).toBe(303);

    // 04, "`submitted --> draft --> submitted` is one move": a submitter who
    // fixes a typo must not silently drop out of the committee's queue.
    const row = await env.DB.prepare("SELECT status, abstract FROM proposal WHERE id = ?").bind(proposalId).first<{ status: string; abstract: string }>();
    expect(row?.abstract).toContain("Updated: now includes 2026 benchmark data.");
    expect(row?.status).toBe("submitted");
  });

  it("INV-11-7 / INV-04-11: the submitter's own view of the proposal carries no review data", async () => {
    const html = await SELF.fetch(`http://localhost/portal/proposals/${proposalId}`, withCookie(cookie));
    const body = await html.text();
    expect(body.toLowerCase()).not.toContain("review score");
    expect(body.toLowerCase()).not.toMatch(/reviewer/);

    const api = await SELF.fetch(`http://localhost/v1/proposals/${proposalId}`, withCookie(cookie));
    expect(api.status).toBe(200);
    const json = await api.json<Record<string, unknown>>();
    expect(json).not.toHaveProperty("reviews");
    expect(json).not.toHaveProperty("scores");
    expect(json).not.toHaveProperty("reviewer_identities");
  });

  it("a submitter is denied another submitter's proposal entirely", async () => {
    const otherCookie = await signIn(OTHER_SPEAKER_EMAIL, OTHER_SPEAKER_PASSWORD);
    const res = await SELF.fetch(`http://localhost/portal/proposals/${proposalId}`, withCookie(otherCookie, { redirect: "manual" }));
    expect([401, 403]).toContain(res.status);
  });
});

/**
 * Its own draft, because it deliberately leaves a step incomplete and the
 * happy-path suite above walks one proposal from draft to submitted in order.
 */
describe("the wizard's per-step gate (04, rule 2 scoped to a step)", () => {
  let cookie: string;
  let proposalId: string;

  beforeAll(async () => {
    await seed();
    cookie = await signIn(SPEAKER_EMAIL, SPEAKER_PASSWORD);
    const created = await SELF.fetch(
      "http://localhost/portal/proposals/new",
      withCookie(cookie, { method: "POST", body: new URLSearchParams({ cfp_id: CFP }), headers: FORM_HEADERS, redirect: "manual" }),
    );
    proposalId = /prp_[A-Za-z0-9]+/.exec(created.headers.get("location") ?? "")![0];
  });

  /**
   * The roster is collected on "About you" and the format on "About your
   * talk", so a fresh draft has no format when the co-speaker is named.
   * Enforcing INV-04-5 against a default of one made that refuse every time —
   * the cap belongs to a format that has not been chosen yet.
   */
  it("names a co-speaker on a draft with no format yet — the cap waits for a format to exist", async () => {
    const res = await SELF.fetch(
      `http://localhost/portal/proposals/${proposalId}/speakers`,
      withCookie(cookie, {
        method: "POST",
        body: new URLSearchParams({ full_name: "Marcus Okafor", email: "wiz-cospeaker@example.com", redirect_step: "your-details" }),
        headers: FORM_HEADERS,
        redirect: "manual",
      }),
    );
    expect(res.status).toBe(200);
    // INV-01-15: the one-time accept link is shown on screen, never redirected past.
    expect(await res.text()).toContain("/invite/");

    const rows = await env.DB.prepare("SELECT speaker_role, participation_status FROM proposal_speaker WHERE proposal_id = ? ORDER BY sort_order")
      .bind(proposalId)
      .all<{ speaker_role: string; participation_status: string }>();
    expect(rows.results.map((r) => r.speaker_role)).toEqual(["primary", "co_speaker"]);
  });

  it("'Save and continue' with a required answer missing re-renders the step naming it, and does not advance", async () => {
    const res = await SELF.fetch(
      `http://localhost/portal/proposals/${proposalId}/step/the-talk`,
      withCookie(cookie, {
        method: "POST",
        body: new URLSearchParams({ "answer.title": "Only a title", client_revision: "0", next_step_key: "review-and-submit", next: "1" }),
        headers: FORM_HEADERS,
        redirect: "manual",
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Abstract is required.");
    expect(body).toContain("required answer");
    // Still on the step it could not leave.
    expect(body).toContain(`/portal/proposals/${proposalId}/step/the-talk`);

    // Nothing was lost: the answers that were given are persisted anyway.
    const row = await env.DB.prepare("SELECT title, status FROM proposal WHERE id = ?").bind(proposalId).first<{ title: string; status: string }>();
    expect(row?.title).toBe("Only a title");
    expect(row?.status).toBe("draft");
  });

});

describe("admin proposal queue — PII redaction (INV-09-5 / INV-11-4)", () => {
  beforeAll(async () => {
    await seed();
    const speakerCookie = await signIn(OTHER_SPEAKER_EMAIL, OTHER_SPEAKER_PASSWORD);
    await SELF.fetch(
      "http://localhost/portal/proposals/new",
      withCookie(speakerCookie, { method: "POST", body: new URLSearchParams({ cfp_id: CFP }), headers: FORM_HEADERS, redirect: "manual" }),
    );
  });

  /**
   * INV-11-4 on the proposal board. The board is the console's screen and its
   * server-rendered twin is gone (R30, second amendment), so the list endpoint
   * is the only place this can be decided — which is the right place: the
   * client is never handed the address and told not to draw it.
   */
  it("withholds the address from /v1/proposals for a reader without pii.read", async () => {
    const reviewer = await signIn(REVIEWER_EMAIL, REVIEWER_PASSWORD);
    const res = await SELF.fetch(`http://localhost/v1/proposals?event_id=${EVENT}`, {
      headers: { cookie: reviewer, accept: "application/json" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { submitter_email: string | null; submitter_name: string | null }[] };
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data.every((r) => r.submitter_email === null)).toBe(true);
    // The name is not the address: staff screens have always shown it, and a
    // board with no names in it is a board nobody can use.
    expect(body.data.some((r) => r.submitter_name)).toBe(true);

    const owner = await signIn(OWNER_EMAIL, OWNER_PASSWORD);
    const asOwner = await SELF.fetch(`http://localhost/v1/proposals?event_id=${EVENT}`, {
      headers: { cookie: owner, accept: "application/json" },
    });
    const ownerBody = (await asOwner.json()) as { data: { submitter_email: string | null }[] };
    expect(ownerBody.data.some((r) => r.submitter_email === OTHER_SPEAKER_EMAIL)).toBe(true);
  });

  /**
   * `?fields=` on the list (`http/projection.ts`). The board draws columns the
   * reader picks and has no column for the abstract, so it asks for what it
   * draws; the saving is most of the payload at a real event's volume.
   */
  describe("?fields= on /v1/proposals", () => {
    const list = async (cookie: string, query: string) =>
      SELF.fetch(`http://localhost/v1/proposals?event_id=${EVENT}${query}`, {
        headers: { cookie, accept: "application/json" },
      });

    it("returns the whole row when no fields are named, which is what every existing caller asks for", async () => {
      const owner = await signIn(OWNER_EMAIL, OWNER_PASSWORD);
      const body = (await (await list(owner, "")).json()) as { data: Record<string, unknown>[] };
      expect(body.data[0]).toHaveProperty("abstract");
      expect(body.data[0]).toHaveProperty("description");
    });

    it("returns only the named fields, plus the id, which addresses the row", async () => {
      const owner = await signIn(OWNER_EMAIL, OWNER_PASSWORD);
      const res = await list(owner, "&fields=reference,title,status");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Record<string, unknown>[]; total: number };
      expect(body.data.length).toBeGreaterThan(0);
      expect(Object.keys(body.data[0]).sort()).toEqual(["id", "reference", "status", "title"]);
      // The envelope is not a field: pagination and the count survive projection.
      expect(body).toHaveProperty("total");
    });

    /**
     * The safety property the projection rests on: it runs *after* redaction,
     * so it can only ever remove. A reader who may not see an address does not
     * get one by naming it — INV-09-5 decided the row's contents before this
     * parameter was read.
     */
    it("INV-09-5: naming a withheld field does not un-withhold it", async () => {
      const reviewer = await signIn(REVIEWER_EMAIL, REVIEWER_PASSWORD);
      const res = await list(reviewer, "&fields=reference,submitter_email");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { submitter_email: string | null }[] };
      expect(body.data.every((r) => r.submitter_email === null)).toBe(true);
    });

    it("refuses a field it does not return, rather than answering with rows missing it", async () => {
      const owner = await signIn(OWNER_EMAIL, OWNER_PASSWORD);
      const res = await list(owner, "&fields=reference,abstrct");
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: string; field_errors: { field_key: string }[] };
      expect(body.error).toBe("validation_failed");
      expect(body.field_errors[0].field_key).toBe("fields");
    });
  });
});

/**
 * INV-11-16 — an `O` grade authorises a record, not a collection.
 *
 * `/v1/proposals` passes a target naming only the event, which is the whole
 * point of a list. The matrix grades `speaker` as `O` there, and the check
 * accepted `own`, so any speaker with a session anywhere read every proposal in
 * the event — reference, title, abstract, `coi_disclosure`, and each
 * submitter's address, which a `reviewer` is correctly refused because
 * `pii.read` grants them nothing. The `O` cell inverted into more access than
 * the roles above it.
 *
 * Both halves are asserted, because the fix is only correct if it keeps the
 * access `own` exists to give.
 */
describe("own access does not authorise a collection (INV-11-16)", () => {
  it("refuses a speaker the event-wide proposal list", async () => {
    const speaker = await signIn(SPEAKER_EMAIL, SPEAKER_PASSWORD);
    const res = await SELF.fetch(`http://localhost/v1/proposals?event_id=${EVENT}`, {
      headers: { cookie: speaker, accept: "application/json" },
    });
    expect(res.status).toBe(403);
  });

  it("still admits that speaker to their own proposal", async () => {
    const row = await env.DB.prepare("SELECT proposal_id FROM proposal_speaker WHERE person_id = ? LIMIT 1")
      .bind(SPEAKER)
      .first<{ proposal_id: string }>();
    expect(row?.proposal_id).toBeTruthy();
    const speaker = await signIn(SPEAKER_EMAIL, SPEAKER_PASSWORD);
    const res = await SELF.fetch(`http://localhost/v1/proposals/${row?.proposal_id}`, {
      headers: { cookie: speaker, accept: "application/json" },
    });
    expect(res.status).toBe(200);
  });

  it("leaves the list where it was for staff", async () => {
    const owner = await signIn(OWNER_EMAIL, OWNER_PASSWORD);
    const res = await SELF.fetch(`http://localhost/v1/proposals?event_id=${EVENT}`, {
      headers: { cookie: owner, accept: "application/json" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data.length).toBeGreaterThan(0);
  });
});
