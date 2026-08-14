import { describe, expect, it } from "vitest";
import {
  AUDIENCE_LABEL,
  DEFAULT_EMAIL_ACCENT,
  deriveEmailPreheader,
  permissionReasonFor,
  renderEmailBody,
  renderEmailLayout,
  resolveEmailAccent,
} from "@podiumstack/web/ui/email-layout.js";

/**
 * The port of docs/design/emails/ — see that directory's README.md for the
 * visual spec this is ported from. These tests hold the shell to what the
 * spec calls non-negotiable (bulletproof buttons, a hidden preheader, one
 * Podium credit) rather than to the sample copy, which is not shipped.
 */

const BASE = {
  eventName: "AI Engineer NYC 2026",
  orgName: "AI Engineer",
  audienceLabel: AUDIENCE_LABEL.speakers,
  permissionReason: "You are receiving this because you submitted a proposal to AI Engineer NYC 2026.",
  unsubscribeUrl: "https://podium.example/unsubscribe?email=a%40b.com&category=proposal&sig=abc",
};

describe("audience label and permission reason (09, Notifications)", () => {
  it("gives each audience its own header label", () => {
    expect(AUDIENCE_LABEL.organizers).toBe("Program Team");
    expect(AUDIENCE_LABEL.reviewers).toBe("Program Committee");
    expect(AUDIENCE_LABEL.speakers).toBe("Speakers");
    expect(AUDIENCE_LABEL.sponsors).toBe("Sponsors");
  });

  it("states why a reviewer received the message", () => {
    expect(permissionReasonFor("reviewers", "AI Engineer NYC 2026")).toContain("program committee");
  });

  it("states why an organizer received the message", () => {
    expect(permissionReasonFor("organizers", "AI Engineer NYC 2026")).toContain("program team");
  });

  it("states why a sponsor contact received the message", () => {
    expect(permissionReasonFor("sponsors", "AI Engineer NYC 2026")).toContain("sponsors");
  });

  it("states why a speaker received the message", () => {
    expect(permissionReasonFor("speakers", "AI Engineer NYC 2026")).toContain("submitted a proposal");
  });
});

describe("event-name header, falling back to the organization (README: 'left: event name — fall back to org name when there is no event')", () => {
  it("uses the event name when there is one", () => {
    const html = renderEmailLayout({ ...BASE, bodyMarkdown: "Hi there.", plainTextBody: "Hi there." });
    expect(html).toContain(">AI Engineer NYC 2026<");
  });

  it("falls back to the organization name when there is no event", () => {
    // The permission reason in BASE still names the event by text, so assert
    // on the header cell specifically rather than the whole document.
    const html = renderEmailLayout({ ...BASE, eventName: null, permissionReason: "You are receiving this because you are on the program team.", bodyMarkdown: "Hi there.", plainTextBody: "Hi there." });
    const headerCell = html.slice(html.indexOf('align="left"'), html.indexOf('align="left"') + 300);
    expect(headerCell).toContain(">AI Engineer<");
    expect(headerCell).not.toContain("AI Engineer NYC 2026");
  });
});

describe("Podium is a footer credit only (12-glossary.md: conference-first branding)", () => {
  it("mentions Podium exactly once, in the muted footer credit", () => {
    const html = renderEmailLayout({ ...BASE, bodyMarkdown: "Hi there. Thanks for **submitting**.", plainTextBody: "Hi there." });
    const matches = html.match(/Podium/g) ?? [];
    expect(matches.length).toBe(1);
    expect(html).toContain("Program run on Podium");
  });

  it("does the same for an internal audience (organizers) as for an external one (speakers)", () => {
    const html = renderEmailLayout({ ...BASE, audienceLabel: AUDIENCE_LABEL.organizers, bodyMarkdown: "Coverage update.", plainTextBody: "Coverage update." });
    expect((html.match(/Podium/g) ?? []).length).toBe(1);
  });
});

describe("accent applies only to the call-to-action, links and footer links", () => {
  const accent = "#7a2f9e";

  it("colors a lone-link paragraph's CTA button with the accent", () => {
    const html = renderEmailBody("Confirm here.\n\nhttps://example.com/confirm", accent);
    expect(html).toContain(`bgcolor="${accent}"`);
  });

  it("colors an inline link with the accent, not the button treatment", () => {
    const html = renderEmailBody("Read the [guidelines](https://example.com/guidelines) before you write your talk.", accent);
    expect(html).toContain(`color:${accent}`);
    expect(html).not.toContain("bgcolor=");
  });

  it("does not apply the accent to plain body text", () => {
    const html = renderEmailBody("Just an ordinary paragraph with no links or emphasis.", accent);
    expect(html).not.toContain(accent);
  });

  it("defaults to the design system's accent when none is configured", () => {
    expect(resolveEmailAccent(null, null)).toBe(DEFAULT_EMAIL_ACCENT);
    expect(resolveEmailAccent({}, {})).toBe(DEFAULT_EMAIL_ACCENT);
  });

  it("prefers the event's accent over the organization's — Event.settings overrides org settings, same keys (02)", () => {
    expect(resolveEmailAccent({ branding: { email_accent: "#123456" } }, { branding: { email_accent: "#654321" } })).toBe("#123456");
  });

  it("falls back to the organization's accent when the event sets none", () => {
    expect(resolveEmailAccent(null, { branding: { email_accent: "#654321" } })).toBe("#654321");
  });

  it("ignores a malformed accent value rather than emitting invalid CSS", () => {
    expect(resolveEmailAccent({ branding: { email_accent: "not-a-color" } }, null)).toBe(DEFAULT_EMAIL_ACCENT);
  });
});

describe("hard-wrapped paragraphs merge into one block (standard markdown paragraph semantics)", () => {
  it("joins consecutive plain-text lines with a single space, as one row, not one per source line", () => {
    const html = renderEmailBody("Please confirm by the deadline. If we do not hear from you by then\nthe slot is released to somebody else.", DEFAULT_EMAIL_ACCENT);
    // Exactly one paragraph row for the whole sentence...
    expect((html.match(/<tr>/g) ?? []).length).toBe(1);
    // ...joined with a single space at the wrap point, not a run of spaces or none at all.
    expect(html).toContain("by then the slot is released");
    expect(html).not.toContain("by then  the slot");
    expect(html).not.toContain("by thenthe slot");
  });

  it("still starts a new paragraph on a blank line", () => {
    const html = renderEmailBody("First paragraph,\nstill first paragraph.\n\nSecond paragraph.", DEFAULT_EMAIL_ACCENT);
    expect((html.match(/<tr>/g) ?? []).length).toBe(2);
    expect(html).toContain("First paragraph, still first paragraph.");
  });
});

describe("a paragraph that is only a link renders as a bulletproof CTA button (README, 'CTA button')", () => {
  it("promotes a bare URL on its own line to a button", () => {
    const html = renderEmailBody("Please respond.\n\nhttps://example.com/confirm\n\nThanks.", DEFAULT_EMAIL_ACCENT);
    expect(html).toContain('href="https://example.com/confirm"');
    expect(html).toContain("display:block");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<img");
  });

  it("promotes a lone markdown link, using its label as the button text", () => {
    const html = renderEmailBody("[Confirm your slot](https://example.com/confirm)", DEFAULT_EMAIL_ACCENT);
    expect(html).toContain(">Confirm your slot<");
    expect(html).toContain('href="https://example.com/confirm"');
  });

  it("promotes only the first lone link; a second one stays a text link", () => {
    const html = renderEmailBody("https://example.com/first\n\nhttps://example.com/second", DEFAULT_EMAIL_ACCENT);
    // Exactly one bulletproof button cell...
    expect((html.match(/bgcolor="/g) ?? []).length).toBe(1);
    expect(html).toContain('href="https://example.com/first"');
    // ...and the second is still a real, clickable link — styled as text, not a button.
    expect(html).toContain(`<a href="https://example.com/second" style="color:${DEFAULT_EMAIL_ACCENT}; text-decoration:underline;">https://example.com/second</a>`);
  });

  it("does not promote a link that is part of a sentence", () => {
    const html = renderEmailBody("You can edit and resubmit here: https://example.com/edit", DEFAULT_EMAIL_ACCENT);
    expect(html).not.toContain("bgcolor=");
    expect(html).toContain("https://example.com/edit");
  });

  it("a URL isolated by a blank line still promotes to a button (paragraph break, not just a line break)", () => {
    const html = renderEmailBody("Confirm your slot.\n\nhttps://example.com/confirm", DEFAULT_EMAIL_ACCENT);
    expect(html).toContain(`bgcolor="${DEFAULT_EMAIL_ACCENT}"`);
    expect(html).toContain('href="https://example.com/confirm"');
  });

  it("a URL on the very next line, with no blank line isolating it, merges into the paragraph instead of promoting", () => {
    const html = renderEmailBody("Confirm your slot.\nhttps://example.com/confirm", DEFAULT_EMAIL_ACCENT);
    // Standard markdown: no blank line means no paragraph break, so this is not
    // "a paragraph consisting solely of a link" — it stays prose with an inline link.
    expect(html).not.toContain("bgcolor=");
    expect(html).toContain("Confirm your slot. ");
    expect(html).toContain(`<a href="https://example.com/confirm" style="color:${DEFAULT_EMAIL_ACCENT}; text-decoration:underline;">https://example.com/confirm</a>`);
  });
});

describe("interpolated content stays HTML-escaped", () => {
  it("escapes markup characters in a plain paragraph", () => {
    const html = renderEmailBody('Reply-to: <script>alert(1)</script> & "quoted"', DEFAULT_EMAIL_ACCENT);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
  });

  it("escapes markup characters inside a bolded span", () => {
    const html = renderEmailBody("We accepted **<b>XSS</b> Talk**.", DEFAULT_EMAIL_ACCENT);
    expect(html).not.toContain("<b>XSS</b>");
    expect(html).toContain("&lt;b&gt;XSS&lt;/b&gt;");
  });

  it("never promotes a non-http(s) scheme to a button, and still escapes it as ordinary text", () => {
    const html = renderEmailBody('javascript:alert(1)"><script>', DEFAULT_EMAIL_ACCENT);
    expect(html).not.toContain("bgcolor=");
    expect(html).not.toContain("<script>");
  });
});

describe("the unsubscribe link is omitted on a transactional send (INV-09-10)", () => {
  it("renders no unsubscribe link when unsubscribeUrl is absent, but keeps the permission reason and the Podium credit", () => {
    const { unsubscribeUrl: _unused, ...withoutUnsubscribe } = BASE;
    const html = renderEmailLayout({ ...withoutUnsubscribe, bodyMarkdown: "Your talk was accepted.", plainTextBody: "Your talk was accepted." });
    expect(html).not.toContain(">Unsubscribe<");
    expect(html).toContain(BASE.permissionReason);
    expect(html).toContain("Program run on Podium");
  });

  it("renders the unsubscribe link when unsubscribeUrl is present — a campaign, or any non-transactional send", () => {
    const html = renderEmailLayout({ ...BASE, bodyMarkdown: "Coverage update.", plainTextBody: "Coverage update." });
    expect(html).toContain(">Unsubscribe<");
    expect(html).toContain("category=proposal");
  });

  it("does not leave a dangling separator when preferencesUrl is set but unsubscribeUrl is not", () => {
    const { unsubscribeUrl: _unused, ...withoutUnsubscribe } = BASE;
    const html = renderEmailLayout({
      ...withoutUnsubscribe,
      preferencesUrl: "https://podium.example/preferences",
      bodyMarkdown: "Hi.",
      plainTextBody: "Hi.",
    });
    expect(html).toContain("Email preferences");
    expect(html).not.toContain("&middot;&nbsp;<br>");
    expect(html).not.toContain(">Unsubscribe<");
  });
});

describe("the postal address footer line (01, Organization.postal_address; CAN-SPAM)", () => {
  it("renders the address on its own line, above the Podium credit", () => {
    const html = renderEmailLayout({
      ...BASE,
      postalAddress: "254 Canal Street, New York, NY 10013",
      bodyMarkdown: "Hi.",
      plainTextBody: "Hi.",
    });
    expect(html).toContain("254 Canal Street, New York, NY 10013");
    const addressIndex = html.indexOf("254 Canal Street");
    const creditIndex = html.indexOf("Program run on Podium");
    expect(addressIndex).toBeGreaterThan(-1);
    expect(addressIndex).toBeLessThan(creditIndex);
  });

  it("omits the line entirely — never a blank line or the string 'null' — when the org has no address", () => {
    const html = renderEmailLayout({ ...BASE, postalAddress: null, bodyMarkdown: "Hi.", plainTextBody: "Hi." });
    expect(html).not.toContain("null");
    // No stray <br><br> where the address line would have been.
    expect(html).not.toMatch(/<br>\s*<br>\s*<span style="color:#a5a19c;">Program run on Podium/);
  });

  it("collapses a multi-line address into one visual footer line", () => {
    const html = renderEmailLayout({
      ...BASE,
      postalAddress: "AI Engineer NYC\n254 Canal Street\nNew York, NY 10013",
      bodyMarkdown: "Hi.",
      plainTextBody: "Hi.",
    });
    expect(html).toContain("AI Engineer NYC, 254 Canal Street, New York, NY 10013");
  });

  it("escapes markup in a hand-typed address", () => {
    const html = renderEmailLayout({ ...BASE, postalAddress: "<script>alert(1)</script>", bodyMarkdown: "Hi.", plainTextBody: "Hi." });
    expect(html).not.toContain("<script>alert(1)</script>");
  });
});

describe("hidden preheader (README: 'first element in <body> is a hidden preheader span (~85 chars)')", () => {
  it("derives the preheader from the first non-blank line of the plain-text body", () => {
    expect(deriveEmailPreheader("\n\nYour proposal was accepted.\n\nSecond paragraph.")).toBe("Your proposal was accepted.");
  });

  it("truncates to 85 characters with an ellipsis", () => {
    const long = "x".repeat(200);
    const preheader = deriveEmailPreheader(long);
    expect(preheader.length).toBe(85);
    expect(preheader.endsWith("…")).toBe(true);
  });

  it("is present as the first element inside <body>, hidden from sighted readers", () => {
    const html = renderEmailLayout({ ...BASE, bodyMarkdown: "Your proposal was accepted.\n\nMore detail follows.", plainTextBody: "Your proposal was accepted.\n\nMore detail follows." });
    const bodyStart = html.indexOf("<body");
    const spanStart = html.indexOf("<span", bodyStart);
    const tableStart = html.indexOf("<table", bodyStart);
    expect(spanStart).toBeGreaterThan(-1);
    expect(spanStart).toBeLessThan(tableStart);
    expect(html.slice(spanStart, spanStart + 200)).toContain("display:none");
    expect(html).toContain("Your proposal was accepted.");
  });
});

describe("email-client constraints (README: 'Email-client constraints')", () => {
  const html = renderEmailLayout({
    ...BASE,
    bodyMarkdown: "Hi there.\n\n- One\n- Two\n\n> A quoted note.\n\nhttps://example.com/go",
    plainTextBody: "Hi there.",
  });

  it("uses only role=presentation tables for layout, no flexbox or grid", () => {
    expect(html).not.toContain("display:flex");
    expect(html).not.toContain("display:grid");
    expect(html).toMatch(/<table role="presentation"/);
  });

  it("carries mso-line-height-rule on text cells, for Outlook", () => {
    expect(html).toContain("mso-line-height-rule:exactly");
  });

  it("sets color-scheme for dark-mode survival", () => {
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
  });

  it("ships no images", () => {
    expect(html).not.toContain("<img");
  });

  it("ships no web fonts — Helvetica/Arial stack only", () => {
    expect(html).toContain("Helvetica,Arial,sans-serif");
    expect(html).not.toContain("@font-face");
  });

  it("carries a single <style> block with only the 620px media query", () => {
    const styleBlocks = html.match(/<style>[\s\S]*?<\/style>/g) ?? [];
    expect(styleBlocks.length).toBe(1);
    expect(styleBlocks[0]).toContain("max-width: 620px");
    expect(styleBlocks[0]).toContain(".container");
    expect(styleBlocks[0]).toContain(".px");
    expect(styleBlocks[0]).toContain(".h1");
  });

  it("gives a top-level heading the .h1 class hook the stylesheet's mobile rule targets", () => {
    const withHeading = renderEmailBody("# You're speaking at AI Engineer NYC 2026", DEFAULT_EMAIL_ACCENT);
    expect(withHeading).toContain('class="h1"');
  });
});
