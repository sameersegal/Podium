import { describe, expect, it } from "vitest";
import { resolveContentType, safeServeContentType } from "@podiumstack/domain/content/assets.js";

/**
 * Stored XSS via an uploaded SVG.
 *
 * `resolveContentType` screened the *claimed* content type for anything that
 * renders as markup, and then consulted `EXTENSION_TYPES` first and trusted it
 * outright — so `.svg` mapped to `image/svg+xml` and walked straight past a
 * guard written to stop exactly that. `GET /assets/:id` serves the stored type
 * inline, same-origin, with no content-disposition, so any speaker who could
 * upload a headshot could run script in an organizer's session on every screen
 * that rendered their photo.
 *
 * An SVG is an image everywhere a person reasons about it and a scriptable XML
 * document everywhere a browser does. That gap is the whole bug, and it is why
 * these cases are worth naming individually rather than folding into one loop.
 */
describe("resolveContentType refuses types that render as markup", () => {
  it("does not store an uploaded .svg as image/svg+xml", () => {
    expect(resolveContentType("me.svg", "image/svg+xml")).toBe("application/octet-stream");
  });

  it("does not take the client's word for text/html either", () => {
    expect(resolveContentType("payload", "text/html")).toBe("application/octet-stream");
  });

  it("refuses xhtml, javascript and generic xml", () => {
    expect(resolveContentType("a", "application/xhtml+xml")).toBe("application/octet-stream");
    expect(resolveContentType("b", "text/javascript")).toBe("application/octet-stream");
    expect(resolveContentType("c", "application/xml")).toBe("application/octet-stream");
  });

  it("is not fooled by a parameterised or upper-cased type", () => {
    expect(resolveContentType("d", "IMAGE/SVG+XML; charset=utf-8")).toBe("application/octet-stream");
  });

  it("still resolves the ordinary upload types by extension", () => {
    expect(resolveContentType("deck.pdf", null)).toBe("application/pdf");
    expect(resolveContentType("headshot.png", "application/octet-stream")).toBe("image/png");
    expect(resolveContentType("slides.pptx", null)).toBe(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );
  });
});

/**
 * Fixing the write path does not fix the rows already written. Every asset
 * uploaded before this change still says `image/svg+xml` in the table, and the
 * read path is where the damage happens — so the screen runs again on the way
 * out.
 */
describe("safeServeContentType re-screens what is already stored", () => {
  it("refuses to serve a pre-existing image/svg+xml row as itself", () => {
    expect(safeServeContentType("image/svg+xml")).toBe("application/octet-stream");
  });

  it("passes through the types that are safe to render inline", () => {
    expect(safeServeContentType("image/png")).toBe("image/png");
    expect(safeServeContentType("application/pdf")).toBe("application/pdf");
  });

  it("treats a missing stored type as opaque bytes", () => {
    expect(safeServeContentType(null)).toBe("application/octet-stream");
    expect(safeServeContentType("")).toBe("application/octet-stream");
  });
});
