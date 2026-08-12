---
name: security-audit
description: Run a periodic whole-codebase security review of Podium — authorization and tenancy, authentication and sessions, injection and rendering, uploaded files, CSRF, redirects and SSRF, secrets and PII exposure, availability — and produce verified findings with a concrete exploit path and a fix. Use when someone asks for a security review, a vulnerability assessment, a pentest of the code, an audit before a release or before opening the repo up, or asks whether a specific class of bug (XSS, IDOR, SQL injection, CSRF, SSRF, privilege escalation, data leak across orgs) exists here. Also use on a schedule — quarterly, or before any deploy that changes auth, file handling, or the public surface. Its scripts/attack_surface.py enumerates all ~500 routes with their guards plus every deliberate escape from a safe default, and --check exits non-zero on anything new since the last accepted baseline, so it runs in CI. Not for reviewing a single diff — the built-in /security-review does that.
---

# Security audit

## What this is for

This is the **periodic, whole-codebase** review. The built-in `/security-review` looks at a
diff and asks "did this change introduce a vulnerability"; that catches regressions and misses
everything that was already there. This one starts from the attack surface and works inward,
and it assumes nothing about what was reviewed last time except what the baseline records.

The output is a short list of **verified** findings, each with a request an attacker could
actually send and what they get back. It is not a list of things that look concerning. A
security report padded with "consider adding rate limiting" trains the reader to skim, and the
one real finding in position nine goes unfixed.

## Rules of engagement

Read-only against the repository and against `npm run dev` on localhost. **Do not** point any
tool at podiumstack.com or any deployed instance, do not send traffic to third-party services
the plugins integrate with, and do not use real credentials. If a finding needs proving against
a live target, say so and stop — that is the owner's call to authorise, not yours to assume.

Exploit proofs belong in `tests/integration/`, run against the local D1/KV/R2/Queues that
`npm test` already stands up. A failing integration test is the strongest possible statement
that a finding is real, and it becomes the regression test for the fix.

## Procedure

### 1. Enumerate the surface

```bash
python3 .claude/skills/security-audit/scripts/attack_surface.py          # full inventory
python3 .claude/skills/security-audit/scripts/attack_surface.py --check  # only what's new
python3 .claude/skills/security-audit/scripts/attack_surface.py --json   # for filtering
```

The script does not find bugs. It finds the places where the codebase deliberately steps
outside a safe default, so the review never begins by rediscovering them:

| Check | The question it raises |
|---|---|
| `route-inventory` | All ~500 routes and which guard stands in front of each. Informational; `--check` never gates on it. |
| `route-unguarded` | Routes with no `requireX`/`assertCanX` in the handler body, outside the public surface. |
| `html-unescaped` | `raw()` with a non-literal argument — HTML that skipped `escapeHtml`. |
| `client-html-sink` | `innerHTML` / `eval` in `public/`. |
| `sql-interpolated` | SQL assembled by interpolation rather than bound parameters. |
| `sql-unscoped` | `db.raw()` / `rawRun()` naming no `org_id` — these bypass `buildWhere`, so INV-11-1 and INV-11-2 are the caller's job. |
| `cookie-attributes` | Hand-assembled `Set-Cookie` strings and which flags they omit. |
| `security-headers` | Hardening headers the codebase never sets anywhere. |
| `redirect-dynamic` | `redirect()` to a variable — open-redirect candidates. |
| `outbound-fetch` | `fetch()` to a non-literal URL — the SSRF surface. |
| `response-content-type` | Responses whose `Content-Type` comes from stored data. |
| `secret-literal` | Secret-shaped names assigned string literals. |

Every line it prints is a question, not a defect. `GET /schedule` with no guard is the product
working; the same shape under `/admin` is the finding. Deciding which is which is the whole job.

### 2. Run the analyzers — but know what they can and cannot see here

```bash
uv tool install semgrep                                  # or pipx/pip
npm run security:semgrep                                 # this repo's own rules
npm audit --omit=dev                                     # 65 packages, 1 at runtime
```

**Stock rulesets find nothing in this codebase, and that is not a clean bill of health.**
This was measured, not assumed: six Semgrep packs — `p/javascript`, `p/typescript`,
`p/secrets`, `p/owasp-top-ten`, `p/xss`, `p/sql-injection`, `p/command-injection`, 363 rules
over 236 files — returned **zero** application-code findings. The only hits were eight
unpinned GitHub Action tags in `.github/workflows/ci.yml`.

That is the expected result. Stock rules look for Express, React, `child_process`,
`mysql.query`, `dangerouslySetInnerHTML`. None of them exist here. This app's dangerous
operations are its own — `raw()`, `db.raw()`, `redirect()`, `input.str()` — and a scanner
that has never been told about those four cannot find a bug in it. Run the stock packs once a
year to catch a newly-introduced ecosystem dependency; do not read a zero from them as safety.

The rules that do work are in [`rules/podium.yml`](rules/podium.yml), and they encode this
repo's sinks. Keep them and `attack_surface.py` in sync — the division is deliberate:
Semgrep is better at *presence* (this tainted value reaches that sink), the Python script is
better at *absence* (this route has no guard at all), which Semgrep expresses badly.

Two things learned the hard way, so nobody re-derives them:

- **Taint mode over-matches here.** The first version of `podium-raw-html-*` used
  `mode: taint` with `symbolic_propagation`, and because this codebase threads view-model
  objects through several layers, taint reached 72 call sites and four route files timed
  out. The rule now matches the narrow shape where injection actually enters — an
  interpolated template literal handed to `raw()`. A rule that flags 72 sites is a rule
  nobody runs twice.
- **Two unrelated functions in this repo are called `raw`** — the HTML escaper's escape
  hatch and the repository's SQL escape hatch. Any rule naming one must exclude the other,
  or the SQL rules fire all over `ui/layout.ts`.

**CodeQL is not currently an option, for two independent reasons.** It publishes no
linux-arm64 build, so it cannot run on this machine at all (`codeql-bundle-linux64` is
x86-64; the dev host is aarch64). And on GitHub, code scanning is free only for **public**
repositories — `sameersegal/Podium` is private, so CodeQL in Actions needs GitHub Advanced
Security. If the repo is made public, add the standard `github/codeql-action` workflow with
`languages: javascript-typescript`; it will still need custom models teaching it that `raw()`
is an XSS sink and `input.str()` is a request source, so budget that work rather than
expecting the default queries to pay off.

### 3. Work the lanes

The scanner covers what grep can see. These are the lanes where the real bugs in *this*
codebase live, with the file to start from. Work all of them; a review that stops after the
interesting one is how the boring one ships.

**Tenancy and object-level authorization.** `packages/data/src/db.ts` enforces INV-11-1 and
INV-11-2 once, in `buildWhere`, for every read that goes through `select`/`first`/`byId`.
`db.raw()` and `rawRun()` skip it entirely. For each `sql-unscoped` hit, ask whether the query
is scoped transitively through a parent id or not at all. Then the harder half, which no
scanner reaches: **holding a capability is not the same as owning the object.** A handler that
calls `ctx.requireWrite("proposal.edit")` and then acts on `params.id` without checking that
the proposal is one of `principals.relationships.proposal_ids` is an IDOR, and the capability
check will look perfectly correct in review. Walk the `:id`-taking routes for the contexts
where relationship-derived permission is the whole point — submissions, review, onboarding
tasks, sponsorship.

**Authentication and sessions.** `workers/api/src/http/context.ts` (`buildContext`) and
`workers/api/src/contexts/identity/`. Both credentials — session cookie and `Bearer` API key —
are looked up by SHA-256 hash, so the plaintext is never stored; check that stays true of
invitation, reset and magic-link tokens too, and that each is single-use and expiring. Check
cookie flags in `setCookie`, session lifetime, whether a session id rotates on privilege change,
whether anything throttles password attempts, and what `packages/domain/src/identity/credentials.ts`
costs an offline attacker — its Argon2 parameters are deliberately far below the OWASP floor
and the file says why. That is a recorded trade-off against the free plan's 10 ms CPU ceiling,
not a finding to rediscover; if it is still there, report it as a **known accepted risk**, and
only escalate if the plan or the constraint changed.

**Rendering.** `workers/api/src/ui/html.ts` escapes by default and the `html` tag is safe;
`raw()` is the way out, and every `html-unescaped` hit is a question about whether its argument
is attacker-influenced. Read `markdown()` closely — it escapes first and then re-introduces
tags by regex, which is the classic place a subset renderer goes wrong. On the client,
`public/console/kit.js` is the only sink; trace what reaches it.

**Uploaded files.** `packages/domain/src/content/assets.ts` and
`workers/api/src/contexts/content/routes.ts`. `resolveContentType` refuses a *claimed* type
matching `html|xhtml|javascript|xml`, but the extension map is consulted first and decides
independently — so the guard and the map can disagree about the same file. `/assets/:assetId`
serves stored bytes **inline** with the stored type, same-origin. Check the size cap, the scan
gate (INV-11-3), and whether `storageKeyFor` can be steered by a filename.

**CSRF.** There is no token anywhere. The console relies on `SameSite=Lax` plus a JSON content
type; the server-rendered forms rely on `SameSite=Lax` alone. That holds exactly as long as no
state-changing operation is reachable by `GET` and no state-changing `POST` accepts a
simple-request content type from a form. Both are cheap to check and both are one careless
route away from breaking.

**Redirects and outbound requests.** Every `redirect-dynamic` hit: can the value come from the
request? Every `outbound-fetch` hit: can the URL come from an organizer or a plugin config, and
if so does it reach internal addresses (SSRF), including the Cloudflare metadata surface?

**Secrets and PII.** `packages/domain/src/shared/pii.ts` makes redaction default-on and
INV-11-4 keeps PII out of publication snapshots and public API responses. Check the paths that
are not "a response": domain event payloads (`10-domain-events.md`), audit rows, webhook
deliveries, campaign renders, exports, and error messages. Check `wrangler.jsonc` and
`wrangler.production.jsonc` for anything that should be a secret rather than a var.

**Availability.** On the free plan a request has 10 ms of CPU, which makes CPU a security
boundary and not just a performance one. Look for unauthenticated endpoints where an attacker
chooses the work: password verification, export and import size, list endpoints without a
`limit`, and anything that fans out per row.

**Dependencies.** `npm audit --omit=dev`, and check `@noble/hashes` and `wrangler` against
current advisories. Report only what is reachable from this code.

### 4. Verify before you report

For each candidate, before it goes in the report:

1. Name the attacker: anonymous, an authenticated speaker, a reviewer, a sponsor contact, a
   revoked grant holder, or a leaked read-only API key. Most false findings die here, because
   the attacker who could do it does not exist.
2. Write the request. Method, path, headers, body.
3. Prove it. An integration test under `tests/integration/` that fails on `main`, or a `curl`
   against `npm run dev` with the response pasted in.
4. If you cannot prove it, it is not a finding. It can be a note in the "unproven, worth
   watching" section, clearly separated, and it does not get a severity.

Rate what survives:

- **Critical** — unauthenticated remote access to organizer data, or authentication bypass.
- **High** — privilege escalation, cross-person data access, stored XSS in an admin surface.
- **Medium** — reflected XSS, open redirect, CSRF on a real action, PII in a place INV-11-4 says it must not be.
- **Low** — missing hardening whose absence needs another bug to matter.
- **Accepted risk** — the codebase already documents the trade-off. Restate it; do not re-litigate it.

### 5. Report

One section per finding, ordered by severity:

```
### [High] Stored XSS via SVG upload
Where:    packages/domain/src/content/assets.ts:112 (EXTENSION_TYPES), served by
          workers/api/src/contexts/content/routes.ts:262
Attacker: any authenticated speaker (can upload a headshot)
Exploit:  POST a file named `me.svg` containing `<svg onload=...>`; it is stored as
          image/svg+xml and GET /assets/:id returns it inline, same-origin, with no CSP.
Impact:   script runs in the organizer's session on every screen showing that headshot.
Fix:      serve svg as image/svg+xml only with `Content-Security-Policy: sandbox`, or
          rasterise on upload; add `X-Content-Type-Options: nosniff` globally.
Model:    docs/domain/11-cross-cutting.md "Assets" should state the rendering rule.
Proof:    tests/integration/content/asset-content-type.test.ts
```

The `Model:` line is not optional bookkeeping. `docs/domain/` is this repo's specification, so
a security rule that exists only in code is a rule the next feature will delete by accident.
If a finding implies a rule, the fix includes the model edit, in the same commit — run
`/domain-drift` after, as with any other change.

### 6. Record what you accepted

```bash
python3 .claude/skills/security-audit/scripts/attack_surface.py --update-baseline
```

Do this **at the end**, after the real findings are fixed or filed — never at the start, which
would silently bless them. The baseline is this review's memory: it says "a human looked at
these 100 items on this date and they were fine." From then on `npm run security` reports only
what appeared since, which is what makes the next audit an hour instead of a day.

Removing a line from the baseline is how you ask for something to be re-reviewed.

## Cadence

`npm run security` belongs next to `npm run drift` and `npm test` in CI: it is fast, it needs
no network, and it fails only on genuinely new surface. Run the full skill quarterly, and
before any release that touches authentication, file handling, the public surface, or the
authorization matrix in `docs/domain/11-cross-cutting.md`.
