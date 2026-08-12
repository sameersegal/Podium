import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "@podiumstack/domain/identity/credentials.js";

/**
 * `POST /v1/forms/:formId/reorder` — the write the drag-and-drop form builder
 * produces (R30, 02-event-configuration.md).
 *
 * The endpoint exists because a drag is not a swap. Dropping a field three
 * positions up renumbers everything between it and where it landed, and moving
 * one into another step changes its parent — neither is expressible as the
 * pairwise moves the HTML builder posts, and applying a multi-position move as
 * a sequence of swaps would check INV-02-8 against an intermediate order nobody
 * asked for.
 *
 * Two invariants have teeth here and both are tested:
 *
 * - **INV-02-8** `visible_when` may only reference fields that precede it. A
 *   drop that moves a field below something that depends on it is refused
 *   *whole* — the partial order must not survive the refusal.
 * - **INV-02-9** a published form is immutable except for cosmetic edits and
 *   `sort_order`, so it may be rearranged in place but a field may not change
 *   step.
 */

const ORG = "org_reorder";
const EVENT = "evt_reorder";
const CFP = "cfp_reorder";
const FORM = "frm_reorder";
const STEP_A = "fst_reorder_a";
const STEP_B = "fst_reorder_b";
/** `role` decides whether `dietary` is shown, so `role` must precede it. */
const F_ROLE = "ffl_reorder_role";
const F_DIETARY = "ffl_reorder_dietary";
const F_NOTES = "ffl_reorder_notes";
const F_IN_B = "ffl_reorder_in_b";

const ADMIN = "per_reorder_admin";
const ADMIN_EMAIL = "reorder-admin@example.com";
const ADMIN_PASSWORD = "reorder-admin-password";

async function run(sql: string, params: unknown[] = []): Promise<void> {
  await env.DB.prepare(sql).bind(...params).run();
}

async function seed(): Promise<void> {
  const now = new Date().toISOString();
  await run(
    "INSERT OR IGNORE INTO organization (id, name, slug, default_timezone, contact_email, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    [ORG, "Reorder Org", "reorder-org", "UTC", "a@b.example", JSON.stringify({ auth: { password_login_enabled: true } }), now, now],
  );
  await run(
    "INSERT OR IGNORE INTO event (id, org_id, name, slug, timezone, starts_on, ends_on, mode, status, visibility, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    [EVENT, ORG, "Reorder Conf", "reorder-conf", "UTC", "2027-09-01", "2027-09-03", "in_person", "active", "public", "{}", now, now],
  );
  await run(
    "INSERT OR IGNORE INTO person (id, org_id, email, full_name, status, is_placeholder, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    [ADMIN, ORG, ADMIN_EMAIL, "Ada Admin", "active", 0, now, now],
  );
  await run(
    "INSERT OR IGNORE INTO auth_identity (id, person_id, provider, subject, credential_hash, credential_updated_at, email_at_provider, created_at) VALUES (?,?,?,?,?,?,?,?)",
    [`aid_${ADMIN}`, ADMIN, "password", ADMIN_EMAIL, hashPassword(ADMIN_PASSWORD), now, ADMIN_EMAIL, now],
  );
  await run(
    "INSERT OR IGNORE INTO role_grant (id, org_id, person_id, role, scope_type, scope_id, granted_by_person_id, granted_at) VALUES (?,?,?,?,?,?,?,?)",
    ["rg_reorder_admin", ORG, ADMIN, "admin", "org", ORG, ADMIN, now],
  );
  await run(
    `INSERT OR IGNORE INTO call_for_proposals
       (id, event_id, name, slug, audience, opens_at, closes_at, grace_period_minutes, late_submission_policy,
        allow_edit_after_submit, withdraw_allowed_until, notify_on_submit, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [CFP, EVENT, "Reorder CFP", "reorder-cfp", "public", "2027-01-01T00:00:00.000Z", "2027-04-01T00:00:00.000Z", 0, "reject", 1, "decision", 1, now, now],
  );
  await run("INSERT OR IGNORE INTO submission_form (id, cfp_id, version, status, created_at) VALUES (?,?,?,?,?)", [
    FORM,
    CFP,
    1,
    "draft",
    now,
  ]);
  await run("INSERT OR IGNORE INTO form_step (id, form_id, key, title, sort_order, is_optional) VALUES (?,?,?,?,?,?)", [STEP_A, FORM, "about", "About", 0, 0]);
  await run("INSERT OR IGNORE INTO form_step (id, form_id, key, title, sort_order, is_optional) VALUES (?,?,?,?,?,?)", [STEP_B, FORM, "extras", "Extras", 1, 0]);

  const field = (id: string, step: string, key: string, label: string, order: number, visibleWhen: string | null) =>
    run(
      "INSERT OR IGNORE INTO form_field (id, step_id, form_id, key, label, type, is_required, visible_when, maps_to, audience, pii, sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      [id, step, FORM, key, label, "short_text", 0, visibleWhen, "none", "public", 0, order],
    );

  await field(F_ROLE, STEP_A, "role", "Your role", 0, null);
  // Shown only when `role` says so — so `role` has to come first (INV-02-8).
  await field(F_DIETARY, STEP_A, "dietary", "Dietary needs", 1, JSON.stringify({ all: [{ field: "role", op: "eq", value: "speaker" }] }));
  await field(F_NOTES, STEP_A, "notes", "Anything else", 2, null);
  await field(F_IN_B, STEP_B, "extra", "An extra", 0, null);
}

async function signIn(): Promise<string> {
  const res = await SELF.fetch("http://localhost/login", {
    method: "POST",
    body: new URLSearchParams({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    redirect: "manual",
  });
  const match = /podium_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "");
  if (!match) throw new Error(`sign-in failed (${res.status})`);
  return `podium_session=${match[1]}`;
}

async function orderOf(): Promise<Record<string, { step: string; sort: number }>> {
  const rows = await env.DB.prepare("SELECT id, step_id, sort_order FROM form_field WHERE form_id = ?")
    .bind(FORM)
    .all<{ id: string; step_id: string; sort_order: number }>();
  const out: Record<string, { step: string; sort: number }> = {};
  for (const r of rows.results ?? []) out[r.id] = { step: r.step_id, sort: r.sort_order };
  return out;
}

describe("form reorder", () => {
  let cookie: string;

  beforeAll(async () => {
    await seed();
    cookie = await signIn();
  });

  const reorder = (body: Record<string, unknown>) =>
    SELF.fetch(`http://localhost/v1/forms/${FORM}/reorder`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    });

  it("applies a whole new order in one write", async () => {
    // notes → role → dietary. `dietary` still follows `role`, so this is legal.
    const res = await reorder({
      fields: [
        { id: F_NOTES, step_id: STEP_A, sort_order: 0 },
        { id: F_ROLE, step_id: STEP_A, sort_order: 1 },
        { id: F_DIETARY, step_id: STEP_A, sort_order: 2 },
      ],
    });
    expect(res.status).toBe(200);

    const order = await orderOf();
    expect(order[F_NOTES].sort).toBe(0);
    expect(order[F_ROLE].sort).toBe(1);
    expect(order[F_DIETARY].sort).toBe(2);
  });

  it("moves a field into another step", async () => {
    const res = await reorder({ fields: [{ id: F_NOTES, step_id: STEP_B, sort_order: 1 }] });
    expect(res.status).toBe(200);
    expect((await orderOf())[F_NOTES].step).toBe(STEP_B);

    // Put it back, so the ordering test below reads a known form.
    await reorder({ fields: [{ id: F_NOTES, step_id: STEP_A, sort_order: 0 }] });
    expect((await orderOf())[F_NOTES].step).toBe(STEP_A);
  });

  it("INV-02-8 refuses a drop that moves a field below the condition that depends on it, and moves nothing", async () => {
    const before = await orderOf();

    // `dietary` is shown only when `role` has a particular answer, so putting
    // `role` after it leaves the rule pointing forwards.
    const res = await reorder({
      fields: [
        { id: F_DIETARY, step_id: STEP_A, sort_order: 0 },
        { id: F_ROLE, step_id: STEP_A, sort_order: 1 },
      ],
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { invariant: string; message: string };
    expect(body.invariant).toBe("INV-02-8");
    expect(body.message).toContain("dietary");

    // The refusal is whole: a partially applied order would leave the form in
    // the state the invariant just refused.
    expect(await orderOf()).toEqual(before);
  });

  /**
   * The console's builder reads this one endpoint and draws its inspector from
   * it, so a field attribute the payload omits is one no organizer can set. It
   * has already happened once: `identifies_speaker` exists because a blind
   * round was showing speaker bios, and a builder that cannot set the flag
   * cannot fix that.
   */
  it("the builder payload carries every attribute the inspector edits", async () => {
    const res = await SELF.fetch(`http://localhost/v1/cfps/${CFP}/builder`, { headers: { cookie, accept: "application/json" } });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: { form: { steps: { fields: Record<string, unknown>[] }[] }; field_types: unknown[]; maps_to: unknown[]; audiences: unknown[] };
    };
    const field = data.form.steps.flatMap((s) => s.fields)[0];
    for (const attribute of [
      "id",
      "key",
      "label",
      "help_text",
      "placeholder",
      "type",
      "options",
      "is_required",
      "visible_when",
      "maps_to",
      "audience",
      "pii",
      "identifies_speaker",
      "sort_order",
    ]) {
      expect(field, `the builder cannot edit what it is not sent: ${attribute}`).toHaveProperty(attribute);
    }
    // And the catalogues the pickers are drawn from, so neither can drift from
    // the enums the model owns.
    expect(data.field_types.length).toBeGreaterThan(0);
    expect(data.maps_to.length).toBeGreaterThan(0);
    expect(data.audiences.length).toBeGreaterThan(0);
  });

  it("INV-02-9 rearranges a published form in place but refuses to move a field to another step", async () => {
    await run("UPDATE submission_form SET status = 'published', published_at = ? WHERE id = ?", [new Date().toISOString(), FORM]);

    const rearrange = await reorder({
      fields: [
        { id: F_ROLE, step_id: STEP_A, sort_order: 0 },
        { id: F_DIETARY, step_id: STEP_A, sort_order: 1 },
        { id: F_NOTES, step_id: STEP_A, sort_order: 2 },
      ],
    });
    expect(rearrange.status).toBe(200); // sort_order is cosmetic

    const before = await orderOf();
    const reparent = await reorder({ fields: [{ id: F_NOTES, step_id: STEP_B, sort_order: 0 }] });
    expect(reparent.status).toBe(422);
    const body = (await reparent.json()) as { invariant: string };
    expect(body.invariant).toBe("INV-02-9");
    expect(await orderOf()).toEqual(before);

    await run("UPDATE submission_form SET status = 'draft', published_at = NULL WHERE id = ?", [FORM]);
  });
});
