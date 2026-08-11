/**
 * The reaction map — 10-domain-events.md.
 *
 * One entry per row of that table. `name` is the idempotency key half:
 * `(DomainEvent.id, handler)` is recorded once the handler has run, so an
 * at-least-once redelivery is a no-op.
 */

import type { Env } from "@podiumconf/data/context.js";
import type { DomainEvent } from "@podiumconf/domain/events/envelope.js";

export interface Reaction {
  name: string;
  /** Event types, `noun.*` wildcards allowed. */
  types: string[];
  handle(ev: DomainEvent, env: Env): Promise<void>;
}

import { SPONSORSHIP_REACTIONS } from "../contexts/sponsorship/reactions.js";
import { PROGRAM_REACTIONS } from "../contexts/program/reactions.js";
import { ONBOARDING_REACTIONS } from "../contexts/onboarding/reactions.js";
import { SCHEDULING_REACTIONS } from "../contexts/scheduling/reactions.js";
import { IDENTITY_REACTIONS } from "../contexts/identity/reactions.js";
import { PLATFORM_REACTIONS } from "../contexts/platform/reactions.js";
import { CONTENT_REACTIONS } from "../contexts/content/reactions.js";

export const REACTIONS: Reaction[] = [
  ...IDENTITY_REACTIONS,
  ...SPONSORSHIP_REACTIONS,
  ...PROGRAM_REACTIONS,
  ...ONBOARDING_REACTIONS,
  ...SCHEDULING_REACTIONS,
  ...CONTENT_REACTIONS,
  // Platform last: webhook fan-out and notification delivery react to
  // everything, including the events the handlers above raise.
  ...PLATFORM_REACTIONS,
];
