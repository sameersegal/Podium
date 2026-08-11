/**
 * Admin UI reference panels for intuitive template and webhook configuration.
 *
 * Renders inline reference information so users can see what data is available
 * without needing to read documentation.
 */

import { html, raw, type SafeHtml } from "../../ui/html.js";
import { badge } from "../../ui/layout.js";
import {
  getAllEvents,
  getEventsByCategory,
  getEventsByPattern,
  getTemplateVariableMetadata,
  getUniqueCategories,
  getEventMetadata,
  getTemplateSpec,
} from "./event-reference.js";

export function renderEventTypeReference(): SafeHtml {
  const categories = getUniqueCategories();

  return html`
    <div class="admin-reference webhook-reference">
      <div class="reference-header">
        <h3>Available Events</h3>
        <p class="small muted">Comma-separated or use wildcards like <code>proposal.*</code> for all proposal events</p>
      </div>
      ${categories.map((cat) => {
        const events = getEventsByCategory(cat);
        const badges = events.map((e) => badge(e.type, e.hasPii ? "pii" : "ok"));
        return html`
          <div class="reference-section">
            <h4>${cat}</h4>
            <div class="event-badges">${badges}</div>
          </div>
        `;
      })}
      <div class="reference-examples">
        <h4>Quick filters</h4>
        <p>
          <code>*</code> — all events<br>
          <code>proposal.*</code> — all proposal events<br>
          <code>session.*</code> — all session events<br>
          <code>review.*</code> — all review events<br>
          <code>notification.*</code> — notifications sent
        </p>
      </div>
    </div>
  `;
}

export function renderEventPayloadReference(eventPattern?: string): SafeHtml {
  let events = getAllEvents();
  if (eventPattern && eventPattern.trim()) {
    events = getEventsByPattern(eventPattern);
  }

  if (events.length === 0) {
    return html`<p class="notice warn">No matching events found</p>`;
  }

  const eventDetails = events.sort((a, b) => a.type.localeCompare(b.type)).map((e) => {
    const piiLabel = e.hasPii ? html` ${badge("contains PII", "pii")}` : raw("");
    return html`
      <div class="event-detail">
        <h4>${e.type}${piiLabel}</h4>
        <p class="small muted">${e.description}</p>
        <p class="small"><strong>Subject:</strong> <code>${e.subject}</code></p>
        <p class="small"><strong>Payload fields:</strong></p>
        <code class="field-list">${e.dataFields.join(", ")}</code>
      </div>
    `;
  });

  return html`
    <div class="admin-reference event-payload-reference">
      <div class="reference-header">
        <h3>Event Payload Structure</h3>
        <p class="small muted">
          Each event includes <code>id</code>, <code>type</code>, <code>version</code>, <code>occurred_at</code>,
          <code>actor</code> (who caused it), <code>subject</code> (the primary entity), and <code>data</code> (type-specific
          payload below).
        </p>
      </div>
      ${eventDetails}
    </div>
  `;
}

export function renderTemplateVariableReference(templateKey?: string): SafeHtml {
  const variables = getTemplateVariableMetadata(templateKey);

  if (variables.length === 0) {
    return html`<p class="notice warn">No variables available</p>`;
  }

  // Group by category
  const byGroup = new Map<string, typeof variables>();
  for (const v of variables) {
    if (!byGroup.has(v.group)) byGroup.set(v.group, []);
    byGroup.get(v.group)!.push(v);
  }

  const spec = templateKey ? getTemplateSpec(templateKey) : null;

  const groupSections = Array.from(byGroup.entries()).map(([group, vars]) => {
    const groupLabel = group === "common" ? "Available in all templates" : group === "template-specific" ? "Specific to this template" : "Available in campaigns";
    const varItems = vars.sort((a, b) => a.name.localeCompare(b.name)).map((v) => {
      const description = v.description ? html` — ${v.description}` : raw("");
      return html`<div class="var-item"><code>{{${v.name}}}</code>${description}</div>`;
    });

    return html`
      <div class="reference-section">
        <h4>${groupLabel}</h4>
        <div class="var-list">${varItems}</div>
      </div>
    `;
  });

  const transactionalNote = spec && spec.transactional ? html`<p class="notice">This is a <strong>transactional</strong> template — never suppressed by unsubscribe preferences.</p>` : raw("");

  return html`
    <div class="admin-reference template-reference">
      <div class="reference-header">
        <h3>Available Variables</h3>
        <p class="small muted">Use <code>{{variable_name}}</code> syntax in the template body. Unknown variables are rejected at save time.</p>
      </div>
      ${transactionalNote}
      ${groupSections}
    </div>
  `;
}

export function renderTemplateListReference(): SafeHtml {
  const templateKeys = [
    "proposal.submitted",
    "proposal.accepted",
    "proposal.rejected",
    "proposal.waitlisted",
    "proposal.changes_requested",
    "task.assigned",
    "task.reminder",
    "schedule.changed",
    "invitation.sent",
    "speaker.confirmation_request",
    "review.assignment",
    "review.reminder",
    "entitlement.expiring_soon",
  ];

  const templateItems = templateKeys.map((key) => {
    const spec = getTemplateSpec(key);
    if (!spec) return null;
    return html`
      <div class="template-item">
        <strong>${key}</strong>
        <p class="small muted">${spec.description}</p>
        <p class="small">Channel: ${badge(spec.channel)}</p>
      </div>
    `;
  }).filter((item) => item !== null);

  return html`
    <div class="admin-reference template-list-reference">
      <div class="reference-header">
        <h3>Known Templates</h3>
        <p class="small muted">Built-in templates tied to system events. Custom templates use a one-off variable set.</p>
      </div>
      <div class="template-list">
        ${templateItems}
      </div>
    </div>
  `;
}
