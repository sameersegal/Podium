-- 0011 — `organization.postal_address`.
--
-- 01 — Identity & Access, Organization: a mailing address, shown on its own
-- line in every outbound email footer (09, "Notifications" — the design
-- handoff's footer spec, docs/design/emails/README.md, "Shared structure"
-- item 11 and "Accessibility & deliverability"). CAN-SPAM requires a postal
-- address on a commercial send, which a `Campaign` is.
--
-- Nullable here on purpose: app.podiumstack.com already carries a live
-- Organization row with no address on it, and this must be an additive
-- migration, never a destructive one. The first-run setup screen makes the
-- field required for every *new* Organization; the organization settings
-- screen is where an existing deployment fills it in afterwards. The email
-- footer omits the address line entirely when it is null rather than
-- rendering an empty line.
--
-- Purely additive: one nullable column, no backfill.
--
-- Reversible on any database that supports it: `ALTER TABLE organization DROP
-- COLUMN postal_address`.

ALTER TABLE organization ADD COLUMN postal_address TEXT;

-- Down (not run automatically; recorded so the change is reversible):
--   ALTER TABLE organization DROP COLUMN postal_address;
