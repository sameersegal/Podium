# Podium

An open-source alternative to SessionBoard, scoped to the jobs an **AI Engineer–style
conference** actually has to get done — not a full clone.

> Unrelated to podium.com (lead management) and to
> [podium-lib](https://podium-lib.io) (micro-frontends), both of which hold the obvious
> namespaces. The repository is still named `kms`.

Six capabilities:

1. **Multi-step submission forms** — abstracts from speakers, sessions from sponsors
2. **Submitter portal** — track proposals, complete onboarding tasks, manage a public profile
3. **Proposal evaluation** — rubrics, rounds, conflicts of interest, decisions
4. **Onboarding** — define what accepted speakers must do, chase it to completion
5. **Public schedule** — an embeddable, versioned, cacheable schedule for the marketing site
6. **APIs and webhooks** — integrate with everything else

Built for Cloudflare, with email and other providers attached as plugins behind capability
contracts.

## Status

**Domain model, in review. No code yet.**

The domain model is the specification the implementation will be generated from and kept in
sync with. Read it first:

→ **[`docs/domain/`](docs/domain/README.md)**

Start with [`00-overview.md`](docs/domain/00-overview.md) for the jobs to be done, the
bounded contexts and the master ERD. Every open question is now resolved — the decisions and
their reasoning are in [`13-open-questions.md`](docs/domain/13-open-questions.md).
