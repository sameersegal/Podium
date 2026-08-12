/**
 * The demonstration deployment — 09, "Demonstration deployments" (INV-09-28),
 * 01 (INV-01-19), R32 in 13-open-questions.md.
 *
 * `app.podiumstack.com` is an instance whose purpose is that strangers sign in
 * and change things. Everything that keeps that safe rather than merely
 * resettable is an egress check and lives where the egress is — the credential
 * (`contexts/platform/service.ts`), the webhook (`contexts/platform/delivery.ts`)
 * and the message (`contexts/platform/notifications.ts`). What is left is this
 * file: how a visitor gets in, how they are told where they are, and how the
 * restore job outside the Worker knows it is pointed at the right deployment.
 *
 * Every route here answers as if it did not exist when `DEMO_MODE` is off,
 * except `/robots.txt`, which every deployment wants — a demonstration asks not
 * to be indexed at all, and a real one still does not want its admin surface in
 * a search result.
 */

import { isDemoDeployment } from "@podiumstack/data/context.js";
import { str, type Row } from "@podiumstack/data/db.js";
import { DomainError } from "@podiumstack/domain/shared/errors.js";
import { SESSION_COOKIE, setCookie, type RequestContext } from "../http/context.js";
import { readInput } from "../http/input.js";
import { json, redirect } from "../http/responses.js";
import type { Router } from "../http/router.js";
import { startSession } from "../contexts/identity/service.js";

/**
 * INV-01-19: the reserved domain, and the whole of the check.
 *
 * RFC 2606 reserves `example.com` for documentation and guarantees no mail can
 * be delivered to it, so an address in it belongs to nobody and can be signed
 * in as without taking anything from anyone. It is also what the seed already
 * uses for its four fixture people, which is why this needs no new column, no
 * flag on `Person`, and nothing for a restore to get wrong.
 *
 * The narrowness is the point. A visitor holding the organizer's permissions
 * can create a `Person` with any address they like; if the check were "any
 * seeded person" or "any person" they could invent one, and on a real
 * deployment reached with `DEMO_MODE` set by accident they could sign in as the
 * owner. They can still create an `@example.com` person — and gain nothing,
 * since they already hold the permissions that would let them.
 */
const RESERVED_DEMO_DOMAIN = "@example.com";

/** Staff land on `/admin`, everybody else in the portal — as `destinationFor` does after a password sign-in. */
const STAFF_ROLES = new Set(["owner", "admin", "program_chair", "track_lead", "organizer", "sponsor_manager", "viewer"]);

interface Persona {
  email: string;
  name: string;
  /** What this person is *for*, in the visitor's language — never a role name from the model. */
  label: string;
  destination: string;
  sort: number;
}

/**
 * The fixture people, discovered rather than listed.
 *
 * A hard-coded list of the seed's four addresses would be a second place the
 * seed's contents are written down, and the first thing to rot when the seed
 * changes. Two queries over a fixture database of seventeen people is cheaper
 * than that maintenance, and it means a persona added to the seed appears on
 * the sign-in page without anybody remembering to come here.
 */
export async function demoPersonas(ctx: RequestContext): Promise<Persona[]> {
  const app = ctx.app();
  const people = await app.db.select<Row>("person", { status: "active" }, { orderBy: "created_at" });
  const candidates = people.filter((p) => str(p.email).toLowerCase().endsWith(RESERVED_DEMO_DOMAIN));
  if (candidates.length === 0) return [];

  const grants = await app.db.select<Row>("role_grant", {});
  const rolesByPerson = new Map<string, Set<string>>();
  for (const g of grants) {
    const personId = str(g.person_id);
    if (!rolesByPerson.has(personId)) rolesByPerson.set(personId, new Set());
    rolesByPerson.get(personId)!.add(str(g.role));
  }

  const personas: Persona[] = [];
  for (const p of candidates) {
    const roles = rolesByPerson.get(str(p.id)) ?? new Set<string>();
    const staff = [...roles].some((r) => STAFF_ROLES.has(r));
    const chair = roles.has("owner") || roles.has("admin") || roles.has("program_chair");
    const reviewer = roles.has("reviewer");
    personas.push({
      email: str(p.email),
      name: str(p.display_name) || str(p.full_name),
      label: chair ? "Run the event" : reviewer ? "Review submissions" : "Speak at it",
      destination: chair ? "/admin" : reviewer ? "/review" : staff ? "/admin" : "/portal",
      sort: chair ? 0 : reviewer ? 1 : 2,
    });
  }
  // Organizer first: it is the seat the product is bought from, and the one
  // screen a visitor who clicks nothing else should land on.
  return personas.sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
}

export function registerDemoRoutes(router: Router<RequestContext>): void {
  /**
   * The restore job's safety interlock (`scripts/demo-reset.mjs`).
   *
   * That job deletes every row in every table of a *remote* database, so what
   * it must never do is run against a real deployment because somebody's
   * environment still held last week's ids. Asking the deployment itself is the
   * only check that survives a wrong `CF_D1_DATABASE_ID`, a stale
   * `wrangler.production.jsonc` or a copy-pasted command: a real deployment
   * answers `demo: false` and the job stops.
   *
   * Public and unauthenticated, because the job runs before it has any
   * credential loaded and the answer is already on every page as a banner. A
   * deployment that is not a demonstration says only that.
   */
  router.get("/demo/status", async (_req, ctx) => {
    if (!isDemoDeployment(ctx.env)) return json({ demo: false });
    return json({
      demo: true,
      org_id: ctx.orgId,
      personas: (await demoPersonas(ctx)).map((p) => ({ email: p.email, name: p.name, label: p.label })),
    });
  });

  /**
   * INV-01-19. No password, and no credential of any kind — see the constant
   * above for why that is narrower than it sounds.
   *
   * `POST` rather than a link: it changes who you are, and a `GET` that does
   * that is reachable from an `<img>` tag on somebody else's page. With
   * `SameSite=Lax` the session cookie this sets would not be sent back on a
   * cross-site form post anyway, but the request that *creates* it should not
   * be forgeable either.
   */
  router.post("/demo/sign-in", async (req, ctx) => {
    assertDemo(ctx);
    const input = await readInput(req);
    const email = input.str("email").trim().toLowerCase();
    const personas = await demoPersonas(ctx);
    const persona = personas.find((p) => p.email.toLowerCase() === email);
    if (!persona) {
      // Deliberately the same refusal whether the address is real, is not in
      // the reserved domain, or is not on this deployment at all: the list of
      // who may be signed in as is on the page above, and nothing else about
      // this org's people belongs in the answer to a guess.
      throw new DomainError({
        code: "demo_persona_unknown",
        message: "Choose one of the demonstration accounts on the sign-in page.",
        status: 403,
      });
    }

    const app = ctx.app();
    const row = await app.db.first<Row>("person", { email: persona.email });
    if (!row) throw new DomainError({ code: "demo_persona_unknown", message: "Choose one of the demonstration accounts on the sign-in page.", status: 403 });
    const token = await startSession(app, str(row.id));
    await app.flush();
    console.log(JSON.stringify({ level: "info", event: "demo.sign_in", person_id: str(row.id), correlation_id: ctx.correlationId }));
    return redirect(persona.destination, 303, {
      "set-cookie": setCookie(SESSION_COOKIE, token, { maxAge: 60 * 60 * 24 }),
    });
  });

  /**
   * Not a demonstration concern on its own — every deployment has an opinion
   * about what a crawler should read — but the demonstration is why it is here.
   * A fixture conference indexed under the product's own domain competes with
   * the marketing site for the product's own name, and outranks it, because it
   * has more pages.
   *
   * The real-deployment answer keeps the public schedule crawlable, which is
   * most of why an organizer wants a public schedule, and keeps the surfaces
   * that are somebody's own data out of an index. `Disallow` is not access
   * control — everything listed here is already behind a session — it just
   * stops a crawler spending its budget on sign-in redirects.
   */
  router.get("/robots.txt", async (_req, ctx) => {
    const body = isDemoDeployment(ctx.env)
      ? "# Demonstration deployment — fixture data, restored hourly.\nUser-agent: *\nDisallow: /\n"
      : "User-agent: *\nDisallow: /admin\nDisallow: /portal\nDisallow: /review\nDisallow: /v1\nDisallow: /login\nDisallow: /signup\n";
    return new Response(body, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        // Long enough that a crawler is not fetching it on every pass, short
        // enough that flipping a deployment into or out of demonstration mode
        // is honoured the same day.
        "cache-control": "public, max-age=3600",
      },
    });
  });
}

function assertDemo(ctx: RequestContext): void {
  if (isDemoDeployment(ctx.env)) return;
  // 404, not 403: on a real deployment this route does not exist, and saying
  // "forbidden" would tell a prober that the code path is in the binary and
  // one variable away from working.
  throw new DomainError({ code: "not_found", message: "No such endpoint.", status: 404 });
}
