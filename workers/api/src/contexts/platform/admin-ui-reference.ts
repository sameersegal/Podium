/**
 * Reference panels for the admin console — 09, "Variables and preview".
 *
 * These sit beside the field they explain, because the organizer filling in
 * `event_types` or a template body has not read `docs/domain/` and the form
 * alone does not tell them what the system will accept.
 *
 * Event types and variable names render as `<code>`, never through `badge()`:
 * `humanise()` would turn `task_instance.created` into "Task instance.created",
 * and the whole point of this panel is a string the reader can copy verbatim
 * into the field next to it.
 */

import { html, raw, type SafeHtml } from "../../ui/html.js";
import { badge } from "../../ui/layout.js";
import {
  getAllEvents,
  getEventsByCategory,
  getEventsByPattern,
  getTemplateSpecs,
  getTemplateVariableMetadata,
  getUniqueCategories,
  getTemplateSpec,
} from "./event-reference.js";

/** `warn` reads as "handle with care", which is what personal data is. */
const PII_BADGE = "warn";

/**
 * The `event_types` companion: every published event, grouped the way the
 * catalogue groups them, plus the wildcard forms the field accepts.
 */
export function renderEventTypeReference(): SafeHtml {
  const sections = getUniqueCategories().map((category) => {
    const events = getEventsByCategory(category);
    return html`
      <div class="reference-section">
        <h4>${category}</h4>
        <ul class="event-badges">
          ${events.map(
            (e) => html`<li>
              <code>${e.type}</code>${e.hasPii ? html` ${badge("PII", PII_BADGE)}` : raw("")}
            </li>`,
          )}
        </ul>
      </div>
    `;
  });

  return html`
    <div class="admin-reference webhook-reference">
      <div class="reference-header">
        <h3>Events you can subscribe to</h3>
        <p class="small muted">
          Copy a type into the field, or use a wildcard. Types marked ${badge("PII", PII_BADGE)} carry personal data and
          are redacted unless "include personal data" is on.
        </p>
      </div>
      <div class="reference-examples">
        <h4>Wildcards</h4>
        <p>
          <code>*</code> — everything<br />
          <code>proposal.*</code> — every proposal event<br />
          <code>session.*</code> — every session event<br />
          <code>proposal.accepted, session.created</code> — a comma-separated list
        </p>
      </div>
      ${sections}
    </div>
  `;
}

/**
 * The payload companion: what actually arrives in `data`, optionally narrowed
 * to the patterns the webhook is subscribed to.
 */
export function renderEventPayloadReference(eventPattern?: string): SafeHtml {
  const events = eventPattern?.trim() ? getEventsByPattern(eventPattern) : [...getAllEvents()];

  if (events.length === 0) {
    return html`<div class="admin-reference">
      <p class="notice warn">Nothing matches that filter, so this webhook would never fire.</p>
    </div>`;
  }

  return html`
    <div class="admin-reference event-payload-reference">
      <div class="reference-header">
        <h3>What a delivery looks like</h3>
        <p class="small muted">
          Every delivery carries the same envelope — <code>id</code> (use it to de-duplicate; delivery is at-least-once),
          <code>type</code>, <code>version</code>, <code>occurred_at</code>, <code>actor</code>, <code>subject</code> and
          <code>data</code>. Only <code>data</code> differs per type:
        </p>
      </div>
      ${events.map(
        (e) => html`
          <div class="event-detail">
            <h4><code>${e.type}</code>${e.hasPii ? html` ${badge("PII", PII_BADGE)}` : raw("")}</h4>
            ${e.description ? html`<p class="small muted">${e.description}</p>` : raw("")}
            <p class="small"><strong>Subject:</strong> <code>${e.subject}</code> — ordering is guaranteed per subject only.</p>
            ${e.dataFields.length
              ? html`<p class="small"><strong><code>data</code> keys:</strong></p>
                  <code class="field-list">${e.dataFields.join(", ")}</code>`
              : raw("")}
          </div>
        `,
      )}
    </div>
  `;
}

/**
 * The template-body companion. Shows exactly the set INV-09-13 validates a save
 * against — offering anything wider would promise a variable the save rejects.
 */
export function renderTemplateVariableReference(templateKey?: string | null): SafeHtml {
  const variables = getTemplateVariableMetadata(templateKey);
  const spec = templateKey ? getTemplateSpec(templateKey) : null;

  const groups: { key: VariableGroup; label: string; blurb: string }[] = [
    { key: "template-specific", label: "Specific to this message", blurb: "Only resolvable here." },
    { key: "common", label: "Available in every message", blurb: "" },
  ];

  const sections = groups.map(({ key, label, blurb }) => {
    const inGroup = variables.filter((v) => v.group === key);
    if (inGroup.length === 0) return raw("");
    return html`
      <div class="reference-section">
        <h4>${label}</h4>
        ${blurb ? html`<p class="small muted">${blurb}</p>` : raw("")}
        <div class="var-list">
          ${inGroup.map(
            (v) => html`<div class="var-item">
              <code>{{${v.name}}}</code>${v.description ? html`<span class="small muted">${v.description}</span>` : raw("")}
            </div>`,
          )}
        </div>
      </div>
    `;
  });

  return html`
    <div class="admin-reference template-reference">
      <div class="reference-header">
        <h3>Variables you can use</h3>
        <p class="small muted">
          Write them as <code>{{name}}</code>. A variable that is not on this list is rejected when you save, rather than
          being sent to everyone as an empty string.
        </p>
      </div>
      ${spec?.transactional
        ? html`<p class="notice">
            This message is <strong>transactional</strong> — it reaches the recipient even if they have unsubscribed from
            marketing, because it is about their own proposal, session or task.
          </p>`
        : raw("")}
      ${sections}
    </div>
  `;
}

type VariableGroup = "common" | "template-specific";

/**
 * The key-field companion on the new-template form: the shipped keys and what
 * each one is sent for. Derived from `DEFAULT_TEMPLATES` so a template added to
 * the domain appears here without a second edit.
 */
export function renderTemplateListReference(): SafeHtml {
  return html`
    <div class="admin-reference template-list-reference">
      <div class="reference-header">
        <h3>Messages the system sends</h3>
        <p class="small muted">
          Use one of these keys to override what Podium already sends. Any other key creates a custom message you send
          yourself, with the common variables only.
        </p>
      </div>
      <div class="template-list">
        ${getTemplateSpecs().map(
          (spec) => html`
            <div class="template-item">
              <strong><code>${spec.key}</code></strong>
              <p class="small muted">${spec.description}</p>
              <p class="small">${badge(spec.channel)}${spec.transactional ? html` ${badge("transactional", "info")}` : raw("")}</p>
            </div>
          `,
        )}
      </div>
    </div>
  `;
}
