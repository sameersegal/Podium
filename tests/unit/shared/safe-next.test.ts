import { describe, expect, it } from "vitest";
import { safeNext } from "@podiumstack/web/http/context.js";

/**
 * Open redirect on the post-sign-in `?next=`.
 *
 * `POST /login` redirected to `input.str("next") || "/portal"` with no
 * validation, as did the three sign-in paths inside `POST /signup`. An attacker
 * sends `/login?next=https://evil.example`; the person signs in on the real
 * site, with their real password, and lands on a copy of it — a phishing
 * primitive on the one page they are most likely to trust.
 *
 * The check is on the string rather than on a parsed URL, because the inputs
 * worth defending against are precisely the ones that parse to something other
 * than they read as.
 */
describe("safeNext", () => {
  it("allows an ordinary same-origin path", () => {
    expect(safeNext("/portal/proposals/p_1", "/portal")).toBe("/portal/proposals/p_1");
  });

  it("keeps the query string and fragment of a same-origin path", () => {
    expect(safeNext("/admin/sessions?track=t_1#top", "/portal")).toBe("/admin/sessions?track=t_1#top");
  });

  it("refuses an absolute URL", () => {
    expect(safeNext("https://evil.example", "/portal")).toBe("/portal");
    expect(safeNext("http://evil.example/login", "/portal")).toBe("/portal");
  });

  it("refuses a protocol-relative URL, which reads as a path and is not one", () => {
    expect(safeNext("//evil.example", "/portal")).toBe("/portal");
    expect(safeNext("//evil.example/portal", "/portal")).toBe("/portal");
  });

  it("refuses the backslash form some browsers normalise to //", () => {
    expect(safeNext("/\\evil.example", "/portal")).toBe("/portal");
  });

  it("refuses a scheme that is not http at all", () => {
    expect(safeNext("javascript:alert(1)", "/portal")).toBe("/portal");
    expect(safeNext("data:text/html,<script>alert(1)</script>", "/portal")).toBe("/portal");
  });

  it("falls back when there is no next at all", () => {
    expect(safeNext(null, "/portal")).toBe("/portal");
    expect(safeNext(undefined, "/portal")).toBe("/portal");
    expect(safeNext("", "/portal")).toBe("/portal");
  });
});
