/**
 * Sign-in, sign-up and invitation acceptance.
 *
 * R23 / INV-01-15 — at least one non-inbox path to every role must exist:
 * password login is on wherever no `email` integration is active, and every
 * invitation's `accept_url` is shown on screen when it is created.
 */

import { str } from "@podiumconf/data/db.js";
import { normaliseEmail } from "@podiumconf/domain/identity/types.js";
import { DomainError } from "@podiumconf/domain/shared/errors.js";
import { cookiesOf, flashCookie, safeNext, SESSION_COOKIE, setCookie, clearCookie, type RequestContext } from "../../http/context.js";
import { closeSocketsFor } from "../../surfaces/live.js";
import { readInput } from "../../http/input.js";
import { htmlResponse, redirect } from "../../http/responses.js";
import { assertLoginAllowed, clearLoginFailures, recordLoginFailure } from "../../http/throttle.js";
import type { Router } from "../../http/router.js";
import { html, raw } from "../../ui/html.js";
import { field, page, submitButton } from "../../ui/layout.js";
import {
  acceptInvitation,
  endSession,
  findOrCreatePerson,
  getPerson,
  passwordLoginEnabled,
  setPassword,
  startSession,
  verifyPasswordLogin,
} from "./service.js";

/**
 * `bodyClass: "auth"` is what centres the card in the window rather than
 * pinning it to the top of an otherwise empty page — the sign-in screen is one
 * short form and nothing else, so there is nothing below it to be above.
 */
function authPage(title: string, body: ReturnType<typeof html>, flash?: RequestContext["flash"]) {
  return page({ title, surface: "auth", width: "narrow", flash: flash ?? null, nav: [], bodyClass: "auth" }, body);
}

export function registerAuthRoutes(router: Router<RequestContext>): void {
  router.get("/login", async (_req, ctx) => {
    if (ctx.person) return redirect(destinationFor(ctx));
    const app = ctx.app();
    const passwords = await passwordLoginEnabled(app);
    // Screened on the way in as well as on the way out, so the form does not
    // carry a poisoned value and the "Create one" link cannot propagate one.
    const next = safeNext(ctx.url.searchParams.get("next"), "");
    return htmlResponse(
      authPage(
        "Sign in",
        html`<div class="card">
          <h1>Sign in to Podium</h1>
          ${passwords
            ? html`<form method="post" action="/login" class="stack">
                <input type="hidden" name="next" value="${next}">
                ${field({ name: "email", label: "Email", type: "email", required: true, id: "email" })}
                ${field({ name: "password", label: "Password", type: "password", required: true, id: "password" })}
                ${submitButton("Sign in", "block")}
              </form>`
            : html`<p class="notice warn">Password sign-in is disabled for this organization. Use the invitation link you were sent.</p>`}
          <p class="small muted">No account yet? <a href="/signup${next ? `?next=${encodeURIComponent(next)}` : ""}">Create one</a>.</p>
        </div>`,
        ctx.flash,
      ),
    );
  });

  router.post("/login", async (req, ctx) => {
    const input = await readInput(req);
    const app = ctx.app();
    if (!(await passwordLoginEnabled(app))) {
      throw new DomainError({ code: "password_login_disabled", message: "Password sign-in is disabled.", status: 403 });
    }
    // Before `verifyPasswordLogin`, not after: refusing here is what stops an
    // attacker spending our Argon2 budget, which on the free plan is the
    // scarcest thing the request has.
    const email = input.str("email");
    await assertLoginAllowed(ctx.env, req, email);
    const person = await verifyPasswordLogin(app, email, input.str("password"));
    if (!person) {
      ctx.waitUntil(recordLoginFailure(ctx.env, req, email));
      return htmlResponse(
        authPage(
          "Sign in",
          html`<div class="card">
            <h1>Sign in to Podium</h1>
            <p class="flash err">That email and password did not match.</p>
            <form method="post" action="/login" class="stack">
              ${field({ name: "email", label: "Email", type: "email", required: true, value: input.str("email") })}
              ${field({ name: "password", label: "Password", type: "password", required: true })}
              ${submitButton("Sign in", "block")}
            </form>
            <p class="small muted">No account yet? <a href="/signup">Create one</a>.</p>
          </div>`,
        ),
        { status: 401 },
      );
    }
    const token = await startSession(app, person.id);
    await app.flush();
    ctx.waitUntil(clearLoginFailures(ctx.env, email));
    return redirect(safeNext(input.str("next"), "/portal"), 303, { "set-cookie": setCookie(SESSION_COOKIE, token, { maxAge: 60 * 60 * 24 * 30 }) });
  });

  router.get("/signup", async (_req, ctx) => {
    if (ctx.person) return redirect(destinationFor(ctx));
    // Screened on the way in as well as on the way out, so the form does not
    // carry a poisoned value and the "Create one" link cannot propagate one.
    const next = safeNext(ctx.url.searchParams.get("next"), "");
    return htmlResponse(
      authPage(
        "Create your account",
        html`<div class="card">
          <h1>Create your account</h1>
          <p class="lede">One account covers submitting talks, reviewing, and running an event — what you can do depends on what you have been granted or invited to.</p>
          <form method="post" action="/signup" class="stack">
            <input type="hidden" name="next" value="${next}">
            ${field({ name: "full_name", label: "Full name", required: true, help: "As you write it. It is never split into first and last." })}
            ${field({ name: "email", label: "Email", type: "email", required: true })}
            ${field({ name: "password", label: "Password", type: "password", required: true, help: "At least 8 characters." })}
            ${submitButton("Create account", "block")}
          </form>
          <p class="small muted">Already have an account? <a href="/login">Sign in</a>.</p>
        </div>`,
        ctx.flash,
      ),
    );
  });

  router.post("/signup", async (req, ctx) => {
    const input = await readInput(req);
    const app = ctx.app();
    const email = normaliseEmail(input.str("email"));
    const existing = await app.db.first("person", { email });
    if (existing) {
      const person = await getPerson(app, str(existing.id));
      const identity = await app.db.first("auth_identity", { provider: "password", subject: email });
      if (identity) {
        // Signing up with an email that already has a password is almost always
        // somebody who forgot they had an account. If the password matches, let
        // them in rather than bouncing them to a second form.
        //
        // Which makes this a second password-guessing endpoint, and it has to
        // be throttled like the first — a limit on /login that /signup does not
        // share is not a limit.
        await assertLoginAllowed(ctx.env, req, email);
        const verified = await verifyPasswordLogin(app, email, input.str("password"));
        if (verified) {
          const token = await startSession(app, verified.id);
          await app.flush();
          ctx.waitUntil(clearLoginFailures(ctx.env, email));
          return redirect(safeNext(input.str("next"), "/portal"), 303, {
            "set-cookie": setCookie(SESSION_COOKIE, token, { maxAge: 60 * 60 * 24 * 30 }),
          });
        }
        ctx.waitUntil(recordLoginFailure(ctx.env, req, email));
        return redirect("/login", 303, {
          "set-cookie": flashCookie("info", "You already have an account with that email — sign in instead."),
        });
      }
      // A placeholder person named on a proposal now claims their account.
      await setPassword(app, person.id, input.str("password"));
      await app.db.update("person", person.id, {
        full_name: input.str("full_name") || str(person.full_name),
        is_placeholder: 0,
        status: "active",
        updated_at: app.now(),
      });
      const token = await startSession(app, person.id);
      await app.flush();
      return redirect(safeNext(input.str("next"), "/portal"), 303, {
        "set-cookie": setCookie(SESSION_COOKIE, token, { maxAge: 60 * 60 * 24 * 30 }),
      });
    }

    const person = await findOrCreatePerson(app, {
      email,
      full_name: input.str("full_name"),
      status: "active",
      source: "signup",
    });
    await setPassword(app, person.id, input.str("password"));
    const token = await startSession(app, person.id);
    await app.flush();
    return redirect(safeNext(input.str("next"), "/portal"), 303, {
      "set-cookie": setCookie(SESSION_COOKIE, token, { maxAge: 60 * 60 * 24 * 30 }),
    });
  });

  router.post("/logout", async (req, ctx) => {
    const token = cookiesOf(req)[SESSION_COOKIE];
    const personId = ctx.person?.id ?? null;
    if (token) await endSession(ctx.app(), token);
    // A session that has ended must not keep a live channel open, even one
    // that says as little as this one does. Deferred: closing a socket is not
    // worth delaying the sign-out redirect.
    if (personId) ctx.waitUntil(closeSocketsFor(ctx.env, ctx.orgId, personId));
    return redirect("/", 303, { "set-cookie": clearCookie(SESSION_COOKIE) });
  });

  router.get("/invite/:token", async (_req, ctx, params) => {
    const app = ctx.app();
    const inv = await app.db.first("invitation", { token_hash: await hashOf(params.token) });
    if (!inv) {
      return htmlResponse(
        authPage("Invitation", html`<div class="card"><h1>Invitation not found</h1><p>This link is not valid. Ask whoever invited you for a new one.</p></div>`),
        { status: 404 },
      );
    }
    const known = inv.person_id ? await getPerson(app, str(inv.person_id)) : null;
    return htmlResponse(
      authPage(
        "Accept your invitation",
        html`<div class="card">
          <h1>You have been invited</h1>
          <p class="lede">
            ${describeInvitation(str(inv.kind))} as <strong>${str(inv.email)}</strong>.
          </p>
          ${str(inv.status) !== "pending"
            ? html`<p class="flash warn">This invitation is ${str(inv.status)}.</p>`
            : html`<form method="post" action="/invite/${params.token}" class="stack">
                ${field({ name: "full_name", label: "Your name", required: true, value: known ? str(known.full_name) : "" })}
                ${field({ name: "password", label: "Choose a password", type: "password", help: "At least 8 characters. You can sign in with it from now on." })}
                ${submitButton("Accept invitation")}
              </form>`}
        </div>`,
        ctx.flash,
      ),
    );
  });

  router.post("/invite/:token", async (req, ctx, params) => {
    const input = await readInput(req);
    const app = ctx.app();
    const { person, invitation } = await acceptInvitation(app, params.token, {
      full_name: input.str("full_name"),
      password: input.optional("password"),
    });
    const token = await startSession(app, person.id);
    await app.flush();
    const dest =
      str(invitation.kind) === "reviewer" || str(invitation.kind) === "staff"
        ? "/admin"
        : str(invitation.context_type) === "proposal"
          ? `/portal/proposals/${str(invitation.context_id)}`
          : "/portal";
    return redirect(dest, 303, {
      "set-cookie": setCookie(SESSION_COOKIE, token, { maxAge: 60 * 60 * 24 * 30 }),
    });
  });
}

function describeInvitation(kind: string): string {
  switch (kind) {
    case "reviewer":
      return "You have been invited to review proposals";
    case "staff":
      return "You have been invited to help run an event";
    case "co_speaker":
      return "You have been added as a co-speaker on a proposal";
    case "sponsor_contact":
      return "You have been invited as a sponsor contact";
    default:
      return "You have been invited to the speaker portal";
  }
}

async function hashOf(token: string): Promise<string> {
  const { hashToken } = await import("@podiumconf/domain/identity/credentials.js");
  return hashToken(token);
}

export function destinationFor(ctx: RequestContext): string {
  return ctx.isStaff() ? "/admin" : "/portal";
}

export const AUTH_HELP = raw("");
