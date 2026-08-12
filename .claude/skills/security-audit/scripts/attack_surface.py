#!/usr/bin/env python3
"""
Enumerate this repo's attack surface, mechanically.

The point is not to find bugs — greps do not find bugs. The point is that a
periodic security review should never begin by rediscovering where the trust
boundaries are. There are ~500 routes; nobody eyeballs those twice a year and
stays honest. This prints them, says which ones carry an authorization guard,
and lists every place the codebase deliberately steps outside a safe default:
`raw()` past the HTML escaper, `db.raw()` past the org-scoping in
`buildWhere`, `innerHTML` in the console, a cookie assembled by hand.

Every item it prints is a *question*, not a defect. A public route with no
guard is correct for `/schedule`; the same shape on `/admin/...` is a hole.
Judgement is the reviewer's job. The baseline is how last review's judgement
is remembered:

    attack_surface.py                    # human-readable inventory
    attack_surface.py --json             # same, as JSON
    attack_surface.py --check            # exit 1 on anything not in baseline
    attack_surface.py --update-baseline  # accept the current surface

`--check` is the CI gate: a new unguarded route or a new HTML-escaper bypass
fails the build, and the fix is either to secure it or to record — in the
baseline, in the same commit — that it was reviewed and is fine.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import signal
import sys
from dataclasses import dataclass, field
from pathlib import Path

# `attack_surface.py | head` is the normal way to read this; don't traceback.
if hasattr(signal, "SIGPIPE"):
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)

REPO = Path(__file__).resolve().parents[4]
BASELINE = Path(__file__).resolve().parents[1] / "baseline.json"

SOURCE_ROOTS = ["workers", "packages", "public", "scripts", "migrations"]
SKIP_DIRS = {"node_modules", ".git", ".wrangler", "dist", ".astro", "www"}

SEVERITY_ORDER = {"review": 0, "note": 1}


# --------------------------------------------------------------------------
# Finding model
# --------------------------------------------------------------------------


@dataclass
class Finding:
    check: str
    file: str
    line: int
    label: str
    detail: str = ""

    def fingerprint(self) -> str:
        """Line-number-free, so unrelated edits above don't churn the baseline."""
        return f"{self.check}|{self.file}|{self.label}"

    def as_dict(self) -> dict:
        return {
            "check": self.check,
            "file": self.file,
            "line": self.line,
            "label": self.label,
            "detail": self.detail,
            "fingerprint": self.fingerprint(),
        }


@dataclass
class Check:
    name: str
    question: str
    findings: list[Finding] = field(default_factory=list)
    #: Context for a human reading the report, not something `--check` gates on.
    #: The route inventory is 500 lines and changes every week; gating on it
    #: would mean a baseline update in every feature commit and a gate nobody
    #: reads. `route-unguarded` is the gating half of the same data.
    informational: bool = False


# --------------------------------------------------------------------------
# Source walking
# --------------------------------------------------------------------------


def source_files(exts: tuple[str, ...]) -> list[Path]:
    out: list[Path] = []
    for root in SOURCE_ROOTS:
        base = REPO / root
        if not base.is_dir():
            continue
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
            for name in filenames:
                if name.endswith(exts):
                    out.append(Path(dirpath) / name)
    return sorted(out)


def rel(path: Path) -> str:
    return str(path.relative_to(REPO))


def line_of(text: str, index: int) -> int:
    return text.count("\n", 0, index) + 1


def strip_noise(text: str) -> str:
    """Blank out comments and string bodies so pattern matches mean what they say.

    Keeps offsets identical to the original, so line numbers still line up.
    """
    out = list(text)
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c == "/" and i + 1 < n and text[i + 1] == "/":
            j = text.find("\n", i)
            j = n if j < 0 else j
            for k in range(i, j):
                out[k] = " "
            i = j
        elif c == "/" and i + 1 < n and text[i + 1] == "*":
            j = text.find("*/", i + 2)
            j = n if j < 0 else j + 2
            for k in range(i, j):
                if text[k] != "\n":
                    out[k] = " "
            i = j
        elif c in "\"'":
            j = i + 1
            while j < n and text[j] != c:
                if text[j] == "\\":
                    j += 1
                j += 1
            for k in range(i + 1, min(j, n)):
                out[k] = " "
            i = min(j + 1, n)
        else:
            i += 1
    return "".join(out)


def balanced_span(text: str, open_index: int) -> int:
    """End index (exclusive) of the parenthesised group opening at `open_index`."""
    depth = 0
    i, n = open_index, len(text)
    while i < n:
        c = text[i]
        if c in "\"'`":
            quote = c
            j = i + 1
            while j < n:
                if text[j] == "\\":
                    j += 2
                    continue
                if quote == "`" and text[j] == "$" and j + 1 < n and text[j + 1] == "{":
                    j = balanced_span(text, j + 1) - 1  # skip the interpolation
                elif text[j] == quote:
                    break
                j += 1
            i = j + 1
            continue
        if c == "/" and i + 1 < n and text[i + 1] == "/":
            j = text.find("\n", i)
            i = n if j < 0 else j
            continue
        if c == "/" and i + 1 < n and text[i + 1] == "*":
            j = text.find("*/", i + 2)
            i = n if j < 0 else j + 2
            continue
        if c in "({[":
            depth += 1
        elif c in ")}]":
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    return n


# --------------------------------------------------------------------------
# 1. Routes and their guards
# --------------------------------------------------------------------------

ROUTE_RE = re.compile(r"\brouter\.(get|post|put|patch|delete)\s*\(\s*[\"'`]([^\"'`]+)[\"'`]")

# Ordered: the first pattern that matches decides how the route is classified.
# `require*` is deliberately loose — every guard in this codebase is spelled
# `requireX(ctx)` or `assertCanX(ctx)`, and a guard the scanner fails to
# recognise reports as an unguarded admin route, which is the noise that gets
# a checker switched off. Under-matching here is much worse than over-matching.
GUARD_PATTERNS = [
    ("capability", re.compile(r"\bctx\.require(?:Write|Read)\s*\(")),
    ("capability", re.compile(r"\b(?:assert|ensure)[A-Z]\w*\s*\(")),
    ("capability", re.compile(r"\brequire(?!Person\b)[A-Z]\w*\s*\(")),
    ("capability", re.compile(r"\bctx\.(?:canWrite|canRead|can|isStaff)\s*\(")),
    ("person", re.compile(r"\bctx\.requirePerson\s*\(|\brequirePerson\s*\(")),
    ("dev-only", re.compile(r"\bguard\s*\(\s*ctx\s*\)")),
    ("token", re.compile(r"\b(?:token_hash|hashToken|verifyToken|hashOf)\b")),
]

# Prefixes that are anonymous by design (08 "the public surface", the embed,
# the auth screens themselves). An unguarded route here is expected; anywhere
# else it is the finding.
PUBLIC_PREFIXES = (
    "/login",
    "/logout",
    "/signup",
    "/forgot",
    "/reset",
    "/invite",
    "/magic",
    "/verify",
    "/setup",
    "/health",
    "/embed",
    "/ics",
    "/feed",
    "/.well-known",
    "/robots.txt",
    "/favicon",
    "/schedule",
    "/speakers",
    "/sessions",
    "/sponsors",
    "/assets",
    "/static",
    "/console",
    "/e/",
    "/p/",
)


def is_public_surface(route: str) -> bool:
    return route == "/" or route.startswith(PUBLIC_PREFIXES)


def check_routes() -> tuple[Check, Check]:
    guarded = Check("route-inventory", "Every route, and what stands in front of it.", informational=True)
    unguarded = Check(
        "route-unguarded",
        "Routes with no authorization guard in the handler. Correct for the public "
        "surface; a hole anywhere an organizer's data lives.",
    )

    for path in source_files((".ts",)):
        text = path.read_text(encoding="utf-8", errors="replace")
        if "router." not in text:
            continue
        for m in ROUTE_RE.finditer(text):
            verb, route = m.group(1).upper(), m.group(2)
            open_paren = text.index("(", m.start())
            body = text[open_paren : balanced_span(text, open_paren)]
            clean = strip_noise(body)

            kinds = [kind for kind, pat in GUARD_PATTERNS if pat.search(clean)]
            if kinds:
                kind = kinds[0]
            elif "=>" not in clean and "function" not in clean:
                # `router.post(path, transition("open"))` — the handler is built
                # elsewhere, so its guard is out of this span. Not "unguarded",
                # just not decidable by grep; read the factory yourself.
                kind = "indirect"
            else:
                kind = "none"
            label = f"{verb} {route}"
            guarded.findings.append(
                Finding("route-inventory", rel(path), line_of(text, m.start()), label, kind)
            )
            if kind == "none" and not is_public_surface(route):
                unguarded.findings.append(
                    Finding("route-unguarded", rel(path), line_of(text, m.start()), label,
                            "no requireRead/requireWrite/requirePerson in the handler")
                )
    return guarded, unguarded


# --------------------------------------------------------------------------
# 2. Escapes from safe defaults
# --------------------------------------------------------------------------

# `raw(x)` where x is not a literal: HTML that skipped `escapeHtml`.
RAW_HTML_RE = re.compile(r"(?<![\w.])raw\s*\(\s*(?![\"'`)])")
CLIENT_SINK_RE = re.compile(r"\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML\s*\(|\bdocument\.write\s*\(|\beval\s*\(|new Function\s*\(")
# SQL assembled with interpolation rather than bound parameters.
SQL_INTERP_RE = re.compile(r"\.(?:raw|rawRun|prepare|batch)\s*\(\s*`[^`]*\$\{", re.S)
# `db.raw()` bypasses buildWhere, so it must carry its own org_id (INV-11-1).
SQL_RAW_RE = re.compile(r"\.(?:raw|rawRun)\s*\(\s*[`\"']((?:[^`\"']|\\.)*)", re.S)


def snippet(text: str, index: int, width: int = 110) -> str:
    start = text.rfind("\n", 0, index) + 1
    end = text.find("\n", index)
    end = len(text) if end < 0 else end
    return " ".join(text[start:end].split())[:width]


def check_escapes() -> list[Check]:
    html_sink = Check(
        "html-unescaped",
        "`raw()` with a non-literal argument — HTML that bypassed `escapeHtml`. "
        "Safe only if every interpolated value is already `SafeHtml` or fixed by the code.",
    )
    client_sink = Check(
        "client-html-sink",
        "innerHTML / eval in browser code. Each one is XSS unless its input is "
        "provably not attacker-controlled.",
    )
    sql_interp = Check(
        "sql-interpolated",
        "SQL built by string interpolation instead of bound parameters.",
    )
    sql_unscoped = Check(
        "sql-unscoped",
        "`db.raw()` / `rawRun()` bypass `buildWhere`, so INV-11-1 (org-scoping) and "
        "INV-11-2 (soft deletes) are the caller's job. These queries name neither.",
    )

    for path in source_files((".ts", ".js", ".mjs")):
        text = path.read_text(encoding="utf-8", errors="replace")
        clean = strip_noise(text)
        r = rel(path)

        if path.suffix == ".ts" and r.startswith("workers/") and r != "workers/api/src/ui/html.ts":
            for m in RAW_HTML_RE.finditer(clean):
                html_sink.findings.append(
                    Finding("html-unescaped", r, line_of(text, m.start()), snippet(text, m.start()))
                )

        if r.startswith("public/"):
            for m in CLIENT_SINK_RE.finditer(clean):
                client_sink.findings.append(
                    Finding("client-html-sink", r, line_of(text, m.start()), snippet(text, m.start()))
                )

        for m in SQL_INTERP_RE.finditer(text):
            sql_interp.findings.append(
                Finding("sql-interpolated", r, line_of(text, m.start()), snippet(text, m.start()))
            )

        for m in SQL_RAW_RE.finditer(text):
            sql = m.group(1)
            if not re.search(r"\b(?:select|insert|update|delete)\b", sql, re.I):
                continue
            if re.search(r"\borg_id\b", sql, re.I):
                continue
            # Joins onto an org-scoped parent are scoped transitively; still worth listing.
            sql_unscoped.findings.append(
                Finding("sql-unscoped", r, line_of(text, m.start()), snippet(text, m.start()))
            )

    return [html_sink, client_sink, sql_interp, sql_unscoped]


# --------------------------------------------------------------------------
# 3. Transport, cookies, headers
# --------------------------------------------------------------------------

COOKIE_BUILD_RE = re.compile(r"[\"'`][^\"'`]*(?:Path=|Max-Age=|SameSite=)[^\"'`]*[\"'`]")
SECURITY_HEADERS = {
    "content-security-policy": "stops an injected <script> from doing anything",
    "x-content-type-options": "stops MIME sniffing of uploaded files",
    "strict-transport-security": "stops a downgrade to http",
    "referrer-policy": "stops URLs with ids leaking to third parties",
    "x-frame-options": "stops clickjacking of the admin surfaces",
}


def check_transport() -> list[Check]:
    cookies = Check(
        "cookie-attributes",
        "Hand-assembled Set-Cookie strings. Session cookies want HttpOnly, SameSite "
        "and — over https — Secure.",
    )
    headers = Check(
        "security-headers",
        "Response-hardening headers the codebase never sets.",
    )

    seen_headers: set[str] = set()
    seen_cookie_lines: set[tuple[str, int]] = set()
    for path in source_files((".ts", ".js", ".mjs")):
        text = path.read_text(encoding="utf-8", errors="replace")
        r = rel(path)
        clean = strip_noise(text)
        clean_lines = clean.splitlines()
        raw_lines = text.splitlines()
        # Raw text, not `clean`: a header name is a string literal, and
        # `strip_noise` blanks string bodies. Searching the stripped text found
        # nothing and reported "never set anywhere" about headers that were in
        # fact set on every response — the same bug as `response-content-type`,
        # in a check whose whole output is an absence claim.
        #
        # Comments mentioning a header would now count as setting it, which is
        # why this looks for the assignment shape rather than the bare name.
        for h in SECURITY_HEADERS:
            if re.search(rf'''["']{re.escape(h)}["']\s*[,:)]''', text, re.I):
                seen_headers.add(h)
        # Cookie flags are only visible in the literal, so match the raw text —
        # but only on lines the comment-stripper left standing.
        for m in COOKIE_BUILD_RE.finditer(text):
            line = line_of(text, m.start())
            if line - 1 >= len(clean_lines) or not clean_lines[line - 1].strip():
                continue
            if (r, line) in seen_cookie_lines:
                continue
            seen_cookie_lines.add((r, line))
            # A window, not one line: `setCookie` builds its parts array over
            # four lines, so a single-line view reported HttpOnly missing from
            # the function that appends it two lines down. The window is the
            # smallest thing that reads the way a person would.
            window = "\n".join(raw_lines[max(0, line - 4) : line + 4]).lower()
            missing = [flag for flag in ("HttpOnly", "SameSite", "Secure") if flag.lower() not in window]
            if missing:
                cookies.findings.append(
                    Finding("cookie-attributes", r, line, snippet(text, m.start()),
                            "missing " + ", ".join(missing))
                )

    for h, why in sorted(SECURITY_HEADERS.items()):
        if h not in seen_headers:
            headers.findings.append(Finding("security-headers", "-", 0, h, why))
    return [cookies, headers]


# --------------------------------------------------------------------------
# 4. Untrusted input reaching sensitive sinks
# --------------------------------------------------------------------------

REDIRECT_RE = re.compile(r"\bredirect\s*\(\s*([A-Za-z_$][\w$.]*)")
FETCH_RE = re.compile(r"\bfetch\s*\(\s*(?![\"'`])")
UPLOAD_INLINE_RE = re.compile(r"[\"']content-type[\"']\s*:\s*(?!\s*[\"'])", re.I)


def check_flows() -> list[Check]:
    redirects = Check(
        "redirect-dynamic",
        "`redirect()` to a value held in a variable. If that value can come from the "
        "request, it is an open redirect and a phishing primitive.",
    )
    outbound = Check(
        "outbound-fetch",
        "`fetch()` to a non-literal URL — the SSRF surface (webhooks, plugins, sync).",
    )
    served = Check(
        "response-content-type",
        "Responses whose Content-Type comes from a variable. If that variable is stored "
        "from an upload, the origin serves attacker-chosen types.",
    )

    for path in source_files((".ts",)):
        text = path.read_text(encoding="utf-8", errors="replace")
        clean = strip_noise(text)
        r = rel(path)
        for m in REDIRECT_RE.finditer(clean):
            redirects.findings.append(
                Finding("redirect-dynamic", r, line_of(text, m.start()), snippet(text, m.start()))
            )
        for m in FETCH_RE.finditer(clean):
            outbound.findings.append(
                Finding("outbound-fetch", r, line_of(text, m.start()), snippet(text, m.start()))
            )
        # Raw text, not `clean`: the header *name* is a string literal, and
        # `strip_noise` blanks string bodies.
        for m in UPLOAD_INLINE_RE.finditer(text):
            served.findings.append(
                Finding("response-content-type", r, line_of(text, m.start()), snippet(text, m.start()))
            )
    return [redirects, outbound, served]


# --------------------------------------------------------------------------
# 5. Secrets in the tree
# --------------------------------------------------------------------------

SECRET_RE = re.compile(
    r"""(?ix)
    \b(api[_-]?key|secret|password|passwd|token|private[_-]?key|credential)s?
    \s*[:=]\s*
    ["'`]([^"'`\n]{12,})["'`]
    """
)
SECRET_ALLOW = re.compile(
    r"(?i)^(?:\$\{|process\.env|env\.|<|\{\{|xxx|todo|change[_-]?me|placeholder|example|test|dummy|"
    r"[a-z_.\-]+$)"
)


def check_secrets() -> Check:
    secrets = Check(
        "secret-literal",
        "String literals assigned to secret-shaped names. Seeds and fixtures are fine; "
        "a real key is an incident.",
    )
    for path in source_files((".ts", ".js", ".mjs", ".json", ".jsonc", ".sql")):
        text = path.read_text(encoding="utf-8", errors="replace")
        r = rel(path)
        for m in SECRET_RE.finditer(text):
            value = m.group(2)
            if SECRET_ALLOW.match(value) or " " in value:
                continue
            secrets.findings.append(
                Finding("secret-literal", r, line_of(text, m.start()), f"{m.group(1)} = <{len(value)} chars>")
            )
    return secrets


# --------------------------------------------------------------------------
# Report
# --------------------------------------------------------------------------


def run_all() -> list[Check]:
    inventory, unguarded = check_routes()
    return [inventory, unguarded, *check_escapes(), *check_transport(), *check_flows(), check_secrets()]


def load_baseline() -> dict:
    if not BASELINE.exists():
        return {}
    return json.loads(BASELINE.read_text(encoding="utf-8")).get("accepted", {})


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    ap.add_argument("--check", action="store_true", help="exit 1 on anything not in the baseline")
    ap.add_argument("--update-baseline", action="store_true", help="accept the current surface")
    ap.add_argument("--only", help="comma-separated check names to run")
    args = ap.parse_args()

    checks = run_all()
    if args.only:
        wanted = {s.strip() for s in args.only.split(",")}
        checks = [c for c in checks if c.name in wanted]

    if args.update_baseline:
        accepted = {
            c.name: sorted({f.fingerprint() for f in c.findings})
            for c in checks
            if not c.informational
        }
        BASELINE.write_text(
            json.dumps(
                {
                    "_comment": "Attack surface reviewed and accepted. Anything not listed "
                                "here fails `attack_surface.py --check`. Removing a line is "
                                "how you ask for something to be re-reviewed.",
                    "accepted": accepted,
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        total = sum(len(v) for v in accepted.values())
        print(f"baseline written: {total} accepted items across {len(accepted)} checks")
        return 0

    baseline = load_baseline()
    new: list[Finding] = []
    for c in checks:
        if c.informational:
            continue
        known = set(baseline.get(c.name, []))
        for f in c.findings:
            if f.fingerprint() not in known:
                new.append(f)

    if args.json:
        print(json.dumps(
            {
                "checks": [
                    {
                        "name": c.name,
                        "question": c.question,
                        "count": len(c.findings),
                        "findings": [f.as_dict() for f in c.findings],
                    }
                    for c in checks
                ],
                "new_since_baseline": [f.as_dict() for f in new],
            },
            indent=2,
        ))
    elif args.check:
        if not BASELINE.exists():
            print(
                "No baseline yet, so every item below is unreviewed. This is the\n"
                "correct output for a repo that has never been audited — work through\n"
                "the inventory once, fix what is real, then `--update-baseline`.\n"
            )
        if not new:
            print(f"attack surface unchanged — {sum(len(c.findings) for c in checks)} items, all in baseline")
            return 0
        print(f"{len(new)} item(s) not in the baseline:\n")
        for f in sorted(new, key=lambda x: (x.check, x.file, x.line)):
            print(f"  {f.check:22} {f.file}:{f.line}  {f.label}")
            if f.detail:
                print(f"  {'':22} {f.detail}")
        print("\nReview each, then `--update-baseline` to accept.")
        return 1
    else:
        for c in checks:
            print(f"\n=== {c.name} ({len(c.findings)}) ===")
            print(f"    {c.question}")
            if not c.findings:
                print("    (none)")
                continue
            if c.name == "route-inventory":
                by_kind: dict[str, int] = {}
                for f in c.findings:
                    by_kind[f.detail] = by_kind.get(f.detail, 0) + 1
                for kind, n in sorted(by_kind.items(), key=lambda kv: -kv[1]):
                    print(f"    {n:4}  {kind}")
                continue
            for f in sorted(c.findings, key=lambda x: (x.file, x.line))[:60]:
                loc = f"{f.file}:{f.line}" if f.line else f.file
                print(f"    {loc}  {f.label}")
                if f.detail:
                    print(f"        {f.detail}")
            if len(c.findings) > 60:
                print(f"    … {len(c.findings) - 60} more (use --json)")
        if new:
            print(f"\n{len(new)} item(s) not in the baseline — run with --check for the list.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
