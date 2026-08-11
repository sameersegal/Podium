-- 0009 — `integration.webhook_secret_ref`.
--
-- 09 — API & Integrations, "Capability contracts": `verify_webhook` decides
-- whether an inbound provider callback is genuine (INV-09-16). Some providers
-- sign with a shared secret issued separately from the send credential (Resend
-- via Svix), so `secret_ref` cannot carry it — one integration needs two
-- pointers. Others sign with a public key, which is ordinary config and stays
-- in `config`.
--
-- Like `secret_ref`, this is a *pointer* into the secret store — the name of a
-- Workers Secret binding, never the secret itself (INV-09-3).
--
-- Purely additive: one column, defaulted empty to match `secret_ref`'s shape,
-- no backfill. An integration installed before this migration has no inbound
-- verification configured, which is exactly what empty means, and INV-09-16
-- fails those callbacks closed rather than trusting them.
--
-- Reversible on any database that supports it: `ALTER TABLE integration DROP
-- COLUMN webhook_secret_ref`.

ALTER TABLE integration ADD COLUMN webhook_secret_ref TEXT NOT NULL DEFAULT '';

-- Down (not run automatically; recorded so the change is reversible):
--   ALTER TABLE integration DROP COLUMN webhook_secret_ref;
