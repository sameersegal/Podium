import { describe, expect, it } from "vitest";
import type { ScheduleSnapshot } from "@podiumconf/domain/scheduling/publication.js";
import { applyFilters, corsHeaders, frameAncestorsHeader, layoutGrid } from "@podiumconf/web/contexts/scheduling/widgets.js";

/**
 * The pure helpers behind every `widget_type` × `format` pair: INV-08-6
 * (CORS/frame-ancestors), the filter narrowing that keeps embed payloads
 * small (G), and the grid geometry shared with the admin agenda builder.
 */

function snapshot(): ScheduleSnapshot {
  return {
    publication_id: "pub_1",
    version: 1,
    published_at: "2027-06-01T00:00:00.000Z",
    content_etag: '"abc"',
    event: { id: "evt_1", name: "DevFlow", slug: "devflow", tagline: null, timezone: "UTC", starts_on: "2027-06-01", ends_on: "2027-06-01", website_url: null, venue: null, days: [{ id: "day_1", date: "2027-06-01", label: "Day 1" }] },
    sessions: [
      {
        session_id: "ses_1",
        reference: "ses_1",
        title: "Agents in production",
        subtitle: null,
        abstract: null,
        description: null,
        track: { id: "trk_1", name: "Agents", slug: "agents", color: null },
        format: { id: "fmt_1", name: "Talk", slug: "talk" },
        room: { id: "rom_1", name: "Room A", slug: "room-a", floor: null },
        starts_at: "2027-06-01T09:00:00.000Z",
        ends_at: "2027-06-01T09:30:00.000Z",
        duration_minutes: 30,
        audience_level: null,
        keywords: [],
        language: null,
        speaker_refs: ["per_1"],
        sponsor: null,
        is_sponsored_content: false,
        assets: [],
        registration_url: null,
        capacity: null,
      },
      {
        session_id: "ses_2",
        reference: "ses_2",
        title: "Sponsored: platform tour",
        subtitle: null,
        abstract: null,
        description: null,
        track: { id: "trk_2", name: "Platform", slug: "platform", color: null },
        format: { id: "fmt_1", name: "Talk", slug: "talk" },
        room: { id: "rom_1", name: "Room A", slug: "room-a", floor: null },
        starts_at: "2027-06-01T10:00:00.000Z",
        ends_at: "2027-06-01T10:30:00.000Z",
        duration_minutes: 30,
        audience_level: null,
        keywords: [],
        language: null,
        speaker_refs: ["per_2"],
        sponsor: { id: "spo_1", name: "Acme", slug: "acme", logo_url: null, tier_name: "Gold" },
        is_sponsored_content: true,
        assets: [],
        registration_url: null,
        capacity: null,
      },
    ],
    speakers: [
      { person_id: "per_1", display_name: "Ada Lovelace", pronouns: null, headline: null, job_title: null, company: null, short_bio: null, bio: null, headshot_url: null, links: [], session_refs: ["ses_1"], sort_key: "lovelace" },
      { person_id: "per_2", display_name: "Grace Hopper", pronouns: null, headline: null, job_title: null, company: null, short_bio: null, bio: null, headshot_url: null, links: [], session_refs: ["ses_2"], sort_key: "hopper" },
    ],
    tracks: [
      { id: "trk_1", name: "Agents", slug: "agents", color: null },
      { id: "trk_2", name: "Platform", slug: "platform", color: null },
    ],
    formats: [{ id: "fmt_1", name: "Talk", slug: "talk" }],
    rooms: [{ id: "rom_1", name: "Room A", slug: "room-a", floor: null }],
  };
}

describe("INV-08-6: CORS and frame-ancestors follow allowed_origins exactly", () => {
  it("an unlisted origin gets no CORS headers", () => {
    expect(corsHeaders("https://evil.example", ["https://ok.example"])).toEqual({});
  });

  it("a listed origin gets the standard allow headers", () => {
    const headers = corsHeaders("https://ok.example", ["https://ok.example"]);
    expect(headers["access-control-allow-origin"]).toBe("https://ok.example");
  });

  it("no Origin header at all (same-origin, or a <script>/<iframe> load) gets no CORS headers", () => {
    expect(corsHeaders(null, ["https://ok.example"])).toEqual({});
  });

  it("frame-ancestors names every allowed origin, and refuses framing when there are none", () => {
    expect(frameAncestorsHeader(["https://a.example", "https://b.example"])).toBe("frame-ancestors https://a.example https://b.example");
    expect(frameAncestorsHeader([])).toBe("frame-ancestors 'none'");
  });
});

describe("applyFilters — the embed payload the widget actually renders", () => {
  it("filters sessions by track_ids and narrows speakers to the ones still referenced", () => {
    const filtered = applyFilters(snapshot(), "sessions_list", { track_ids: ["trk_1"] });
    expect(filtered.sessions.map((s) => s.session_id)).toEqual(["ses_1"]);
    expect(filtered.speakers.map((s) => s.person_id)).toEqual(["per_1"]);
  });

  it("sponsor_only keeps only sponsored sessions", () => {
    const filtered = applyFilters(snapshot(), "sessions_list", { sponsor_only: true });
    expect(filtered.sessions.map((s) => s.session_id)).toEqual(["ses_2"]);
  });

  it("a speaker-directory widget keeps the full directory regardless of session filters", () => {
    const filtered = applyFilters(snapshot(), "speakers_list", { track_ids: ["trk_1"] });
    expect(filtered.speakers.map((s) => s.person_id).sort()).toEqual(["per_1", "per_2"]);
  });

  it("narrows tracks/formats/rooms to only what the filtered sessions reference", () => {
    const filtered = applyFilters(snapshot(), "sessions_list", { track_ids: ["trk_1"] });
    expect(filtered.tracks.map((t) => t.id)).toEqual(["trk_1"]);
  });
});

describe("layoutGrid — the geometry behind the .agenda CSS grid", () => {
  it("only includes rooms that actually have something placed", () => {
    const layout = layoutGrid(
      [{ id: "a", room_id: "rom_1", starts_at: "2027-06-01T09:00:00.000Z", ends_at: "2027-06-01T09:30:00.000Z" }],
      [
        { id: "rom_1", name: "Room A" },
        { id: "rom_2", name: "Room B" },
      ],
      "2027-06-01T09:00:00.000Z",
      "2027-06-01T10:00:00.000Z",
      "UTC",
    );
    expect(layout.rooms.map((r) => r.id)).toEqual(["rom_1"]);
    expect(layout.blocks).toHaveLength(1);
    expect(layout.blocks[0].column).toBe(1);
    expect(layout.blocks[0].top_minutes).toBe(0);
    expect(layout.blocks[0].height_minutes).toBe(30);
  });

  it("clips a block to the window rather than overflowing it", () => {
    const layout = layoutGrid(
      [{ id: "a", room_id: "rom_1", starts_at: "2027-06-01T08:30:00.000Z", ends_at: "2027-06-01T09:15:00.000Z" }],
      [{ id: "rom_1", name: "Room A" }],
      "2027-06-01T09:00:00.000Z",
      "2027-06-01T10:00:00.000Z",
      "UTC",
    );
    expect(layout.blocks[0].top_minutes).toBe(0);
    expect(layout.blocks[0].height_minutes).toBe(15);
  });
});
