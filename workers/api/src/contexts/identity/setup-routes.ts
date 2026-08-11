/**
 * First-run setup — 01, "First-run setup" / INV-01-16.
 *
 * Nothing seeds the one `Organization` a deployment needs (01, "Tenancy").
 * This is the anonymous, one-time screen that creates it, atomically with the
 * first `Person`, their `password` `AuthIdentity` and an `owner` `RoleGrant`,
 * then signs them in exactly as `/signup` does.
 *
 * SECURITY: this runs with no principal and creates an administrator, so both
 * routes refuse — on every method — the instant an `Organization` row exists,
 * checked fresh against the database on every request via `ctx.orgId`
 * (`resolveOrgId` in `http/context.ts`, called once per request in
 * `buildContext`, never cached). The actual race-proof backstop is
 * `bootstrap_state`'s single-row primary key, claimed inside
 * `setupOrganization` before anything else is written — see the comment
 * there.
 */

import { DomainError, invariantError } from "@podiumconf/domain/shared/errors.js";
import { setCookie, SESSION_COOKIE, type RequestContext } from "../../http/context.js";
import { readInput } from "../../http/input.js";
import { htmlResponse, redirect } from "../../http/responses.js";
import type { Router } from "../../http/router.js";
import { html, type SafeHtml } from "../../ui/html.js";
import { field, page, submitButton } from "../../ui/layout.js";
import { setupOrganization, startSession } from "./service.js";

/** INV-01-16: refused on every method once an Organization row exists. */
function refuseIfAlreadySetUp(ctx: RequestContext): void {
  if (ctx.orgId) {
    throw invariantError(
      "INV-01-16",
      "organization_already_exists",
      "This deployment has already been set up. Sign in instead.",
      undefined,
      403,
    );
  }
}

interface SetupFormValues {
  org_name?: string;
  org_slug?: string;
  default_timezone?: string;
  contact_email?: string;
  owner_full_name?: string;
  owner_email?: string;
}

function setupFormBody(values: SetupFormValues, error?: string | null): SafeHtml {
  return html`<div class="card">
    <h1>Set up this Podium</h1>
    <p class="lede">
      This deployment has no organization yet. This one-time screen creates it, along with
      your account as its owner. It disappears the moment setup is complete.
    </p>
    ${error ? html`<p class="flash err">${error}</p>` : html``}
    <form method="post" action="/setup" class="stack">
      <h3>Organization</h3>
      ${field({
        name: "org_name",
        label: "Organization name",
        required: true,
        value: values.org_name,
        help: 'The conference-running body — e.g. "AI Engineer".',
      })}
      ${field({
        name: "org_slug",
        label: "URL slug",
        value: values.org_slug,
        placeholder: "auto-generated from the name",
        help: "Lowercase letters, numbers and hyphens. Leave blank to generate one from the name.",
      })}
      ${field({
        name: "default_timezone",
        label: "Default timezone",
        required: true,
        value: values.default_timezone || "UTC",
        help: "IANA name, e.g. America/New_York or Europe/London. The default for every event you create.",
      })}
      ${field({
        name: "contact_email",
        label: "Contact email",
        type: "email",
        required: true,
        value: values.contact_email,
        help: "Reply-to address for platform mail.",
        attrs: 'autocomplete="email" inputmode="email"',
      })}
      <h3>Your account</h3>
      ${field({ name: "owner_full_name", label: "Your full name", required: true, value: values.owner_full_name, attrs: 'autocomplete="name"' })}
      ${field({
        name: "owner_email",
        label: "Your email",
        type: "email",
        required: true,
        value: values.owner_email,
        attrs: 'autocomplete="email" inputmode="email"',
      })}
      ${field({
        name: "owner_password",
        label: "Password",
        type: "password",
        required: true,
        help: "At least 8 characters. You'll sign in with this.",
        attrs: 'autocomplete="new-password"',
      })}
      ${submitButton("Create organization")}
    </form>
  </div>`;
}

function setupPage(ctx: RequestContext, values: SetupFormValues = {}, error?: string | null) {
  return page(
    { title: "Set up Podium", surface: "auth", width: "narrow", flash: ctx.flash, nav: [{ href: "/", label: "Home" }] },
    setupFormBody(values, error),
  );
}

export function registerSetupRoutes(router: Router<RequestContext>): void {
  router.get("/setup", async (_req, ctx) => {
    refuseIfAlreadySetUp(ctx);
    return htmlResponse(setupPage(ctx));
  });

  router.post("/setup", async (req, ctx) => {
    refuseIfAlreadySetUp(ctx);
    const input = await readInput(req);
    const values: SetupFormValues = {
      org_name: input.str("org_name"),
      org_slug: input.str("org_slug"),
      default_timezone: input.str("default_timezone", "UTC"),
      contact_email: input.str("contact_email"),
      owner_full_name: input.str("owner_full_name"),
      owner_email: input.str("owner_email"),
    };
    try {
      const result = await setupOrganization(ctx.env, {
        org_name: values.org_name ?? "",
        org_slug: values.org_slug || null,
        default_timezone: values.default_timezone ?? "UTC",
        contact_email: values.contact_email ?? "",
        owner_full_name: values.owner_full_name ?? "",
        owner_email: values.owner_email ?? "",
        owner_password: input.str("owner_password"),
      });
      const token = await startSession(result.app, result.person_id);
      await result.app.flush();
      return redirect("/admin", 303, {
        "set-cookie": setCookie(SESSION_COOKIE, token, { maxAge: 60 * 60 * 24 * 30 }),
      });
    } catch (err) {
      // Re-render the form with what they typed rather than a bare error page
      // — this is a long form, and re-typing all of it over one typo'd field
      // is exactly the kind of friction this project avoids (F). A second
      // request finding the deployment already set up (INV-01-16) is the one
      // case that still gets the plain error page: there is no form to
      // re-render into, only somewhere else to go (`/login`).
      if (err instanceof DomainError && err.invariant !== "INV-01-16") {
        return htmlResponse(setupPage(ctx, values, err.message), { status: err.status });
      }
      throw err;
    }
  });
}
