# podium-ops

A Claude Code plugin that lets an agent **operate** a hosted [Podium](https://podiumstack.com)
instance — not just read it. Point it at a URL and a token and it can run the CFP, work the
review pile, build and publish the schedule, chase speaker onboarding, manage sponsors, send
campaigns and export the programme.

## Install

```
/plugin marketplace add https://github.com/sameersegal/Podium
/plugin install podium-ops@podium
```

Or from a local checkout:

```
/plugin marketplace add /path/to/podium
/plugin install podium-ops@podium
```

## Configure

Two inputs. Put them in a `.env` the agent can read:

```
PODIUM_URL=https://podium.example.com
PODIUM_API_TOKEN=…
```

Searched in order when `--env` is not passed: `$PODIUM_ENV_FILE`, `./.env`, `./.env.podium`,
`~/.podium/.env`, `~/.podium.env`. Environment variables override the file.

An organizer mints a token at `/admin/api-keys` on the instance. The secret is shown once.
Where password sign-in is enabled — the local dev seed, and instances without an email
integration — the plugin can mint one itself:

```bash
node scripts/podium.mjs bootstrap-key --url http://localhost:8787 \
  --email organizer@example.com --password '…' --save
```

Then check the connection:

```bash
node scripts/podium.mjs whoami
```

**Give the key the scopes the job needs and no more.** A key reaches exactly what its scopes
name; read-only keys read. Three groupings are not guessable from the names: campaigns and
sent-mail history need `speakers:*`, entitlements need `sponsors:*` or `entitlements:*`, and
webhooks, integrations, templates and the audit log need `webhooks:manage`. No key can mint
another key — that is a person's job at `/admin/api-keys`, which now lists what each scope
reaches next to it.

## What's in it

**Skills** — loaded on demand by task:

| Skill | Covers |
|---|---|
| `podium-api` | Connection, auth, scopes, PII, pagination, idempotency, errors, the CLI, and the generated catalogue of all 190 endpoints. Read first. |
| `podium-events` | Create and configure an event; days, rooms, tracks, formats; the CFP and its form |
| `podium-proposals` | The submission pile, review rounds, scores, decisions |
| `podium-schedule` | The agenda grid, conflicts, auto-placement, publishing and rollback |
| `podium-speakers` | Sessions, content approval, speakers, onboarding tasks |
| `podium-sponsors` | Sponsors, sponsorships, entitlements |
| `podium-crm` | Prospects, segments, campaigns |
| `podium-reports` | Dashboards, exports, imports, webhooks, integrations |

**`scripts/podium.mjs`** — a zero-dependency CLI (Node 18+). Generic by design: the skills
carry the recipes, the CLI carries the plumbing that is easy to get wrong — reading the token
without printing it, an `Idempotency-Key` on every write, following `next_cursor`, projecting
list rows down to columns, and turning a typed domain error into a readable diagnosis.

```
podium whoami
podium get   /v1/events
podium list  /v1/proposals event_id=evt_… status=submitted --fields id,title,status
podium post  /v1/events/evt_…/rooms name="Hall A" capacity:=400
podium patch /v1/placements/plc_… start_time=14:00
podium download /files/ast_…/download --out sessions.csv
podium endpoints schedule
```

## Safety

- The token is a credential for a whole organization. Pass `--env`, not `--token`: argv is
  visible in `ps` and in shell history. Nothing here prints the secret.
- `--dry-run` prints a request without sending it. Use it before any bulk write.
- Writes carry an idempotency key, so retrying a timed-out request replays rather than repeats.
- Two actions reach real people and cannot be undone: publishing decisions and sending a
  campaign. Both skills say to confirm with the operator first, and campaigns have
  `preview-audience` for exactly this.
- `pii:read` is additive and off by default. Ask for it only when the task is about contacting
  people, and say when an export contains personal data.

## Maintaining it

`skills/podium-api/reference/endpoints.md` is generated from the product's routes:

```bash
node claude-plugin/scripts/build-endpoints.mjs           # regenerate
node claude-plugin/scripts/build-endpoints.mjs --check   # exit 1 if stale — the CI gate
```

A route added without regenerating the catalogue is drift between the product and what agents
were told about the product, in the same sense as `npm run drift`. `npm run plugin:check` runs
the check.

MIT, same as Podium.
