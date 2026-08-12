/**
 * ICS — 08, "The embed (J10)": "ICS is a first-class output, per event, per
 * track, and per attendee-selected sessions. 'Add to calendar' is the most-used
 * feature of any conference schedule and it is one serialiser away."
 *
 * RFC 5545, the minimum a calendar client needs: VCALENDAR/VEVENT, folded
 * lines, escaped text, UTC instants. Pure string building — no I/O.
 */

import type { PublishedSessionSnapshot, PublishedSpeakerSnapshot, SnapshotEventRef } from "@podiumstack/domain/scheduling/publication.js";

/** RFC 5545 §3.1 — logical lines are folded at 75 octets. */
function foldLine(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let rest = line;
  let first = true;
  while (rest.length > 0) {
    const limit = first ? 75 : 74; // continuation lines start with a space, which counts
    // Fold on a UTF-16 code-unit boundary that keeps each emitted chunk's
    // UTF-8 byte length within the limit — icalendar forbids splitting inside
    // a multi-byte character.
    let take = Math.min(limit, rest.length);
    while (take > 0 && new TextEncoder().encode(rest.slice(0, take)).length > limit) take--;
    out.push((first ? "" : " ") + rest.slice(0, take));
    rest = rest.slice(take);
    first = false;
  }
  return out.join("\r\n");
}

/** RFC 5545 §3.3.11 — backslash, semicolon, comma and newline are escaped. */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

function icsInstant(instant: string): string {
  return instant.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function prop(name: string, value: string): string {
  return foldLine(`${name}:${value}`);
}

export interface IcsSession {
  session_id: string;
  reference: string;
  title: string;
  subtitle: string | null;
  abstract: string | null;
  starts_at: string | null;
  ends_at: string | null;
  room: { name: string; floor: string | null } | null;
  speaker_refs: string[];
  registration_url: string | null;
}

export interface IcsOptions {
  /** Base URL of the deployment, so each event links back to its detail page. */
  baseUrl: string;
  eventSlug: string;
  /** Used for UID stability and DTSTAMP; defaults to `new Date()`. */
  generatedAt?: string;
}

function speakerNames(refs: string[], speakers: PublishedSpeakerSnapshot[]): string {
  const byId = new Map(speakers.map((s) => [s.person_id, s.display_name]));
  return refs.map((id) => byId.get(id)).filter((n): n is string => !!n).join(", ");
}

/**
 * One VCALENDAR over the given sessions — the same serialiser for the whole
 * schedule, a `?track=` slice, and a visitor's starred selection.
 */
export function buildIcs(
  event: Pick<SnapshotEventRef, "name" | "slug" | "timezone">,
  sessions: PublishedSessionSnapshot[],
  speakers: PublishedSpeakerSnapshot[],
  opts: IcsOptions,
): string {
  const stamp = icsInstant(opts.generatedAt ?? new Date().toISOString());
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Podium//Schedule//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    prop("X-WR-CALNAME", escapeText(event.name)),
    prop("X-WR-TIMEZONE", event.timezone),
  ];

  for (const s of sessions.filter((s) => s.starts_at && s.ends_at)) {
    const uid = `${s.session_id}@${new URL(opts.baseUrl).host || "podium.local"}`;
    const names = speakerNames(s.speaker_refs, speakers);
    const descriptionParts = [s.subtitle, s.abstract, names ? `Speakers: ${names}` : null].filter(Boolean) as string[];
    lines.push(
      "BEGIN:VEVENT",
      prop("UID", uid),
      prop("DTSTAMP", stamp),
      prop("DTSTART", icsInstant(s.starts_at!)),
      prop("DTEND", icsInstant(s.ends_at!)),
      prop("SUMMARY", escapeText(s.title)),
    );
    if (descriptionParts.length) lines.push(prop("DESCRIPTION", escapeText(descriptionParts.join("\n\n"))));
    if (s.room) lines.push(prop("LOCATION", escapeText(s.room.floor ? `${s.room.name} (${s.room.floor})` : s.room.name)));
    lines.push(prop("URL", `${opts.baseUrl}/e/${opts.eventSlug}/sessions/${s.session_id}`));
    if (s.registration_url) lines.push(prop("X-PODIUM-REGISTRATION-URL", s.registration_url));
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}
