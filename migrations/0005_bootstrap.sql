-- 0005 — First-run setup: a schema-enforced guarantee that at most one
-- Organization is ever bootstrapped on a deployment (01-identity-and-access.md,
-- "Tenancy": "One Organization per deployment"; INV-01-16).
--
-- `bootstrap_state` is not a modelled entity (docs/domain/README.md: table
-- layout and indexes are left to the implementation, same as
-- `event_reaction_log`). Its only job is to be the *first* write
-- `POST /setup` makes: the row's primary key can hold exactly one value
-- (`id = 1`), so two requests racing to bootstrap the same empty deployment
-- cannot both win — the loser's INSERT fails immediately, before it creates
-- an Organization, a Person, an AuthIdentity or a RoleGrant. The GET/POST
-- `/setup` refusal once an Organization exists (checked fresh against the
-- database on every request, per `resolveOrgId`) is the friendly front door;
-- this constraint is the lock that makes the door actually hold.
--
-- Purely additive: one new table, nothing changed or dropped on any existing
-- one. Reversible with `DROP TABLE bootstrap_state;`.
CREATE TABLE bootstrap_state (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  organization_id TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

-- Down (not run automatically; recorded so the change is reversible):
--   DROP TABLE bootstrap_state;
