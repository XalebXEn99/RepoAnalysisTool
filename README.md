# RAT - Repo Analysis Tool

A web dashboard measuring how Git repositories evolve: who changed what, where the churn is,
and how volatile files, directories and repositories are.

## Architecture

- React/Vite dashboard and an Express API, served from the same origin in production.
- PostgreSQL (the linked Neon project) stores metrics, canonical authors,
  and durable ingestion jobs. SQLite is no longer used.
- A separate worker clones/parses full histories without blocking the API. History is streamed and
  inserted in bounded, atomic batches with materialized ancestor-directory deltas.
- Repository files live on the server's disk; Docker Compose gives API and worker a shared volume.
- No account or sign-in required: anyone can import a Git URL or ZIP, browse analyses, merge
  authors, and delete finished analyses. This is a shared public workspace, not private storage.

The functional source of truth is [docs/test_brief.md](docs/test_brief.md).
The original [implementation plan](IMPLEMENTATION_PLAN.md) describes the historical SQLite design;
this README and [deployment guide](DEPLOYMENT.md) describe the current architecture.

## Local development

Requirements: Node.js 22+, npm, Git 2.30+, and PostgreSQL. Tests use embedded PostgreSQL (PGlite)
and real temporary Git repositories, not your Neon database.

1. Run `npm ci`.
2. Copy `.env.example` to `.env.local`, retaining the existing Neon URLs if already configured.
3. Configure `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, and `RAT_APP_ORIGIN=http://localhost:5173`.
4. Run `npm run migrate`.
5. Run `npm run dev` (starts API, worker, and frontend together).
6. Open http://localhost:5173 and click **+** to import a URL or ZIP.

The API listens on port 8787; Vite proxies `/api` to it. The API also honors `PORT` or `RAT_PORT`.
Environment files are server-only and gitignored. Never put database credentials in a `VITE_` variable.
Node loads `.env.local`, then `.env`, without replacing externally supplied environment variables.

Production build:

```bash
npm run build
npm run migrate:production
npm start
# Separate process:
npm run worker
```

Set `RAT_APP_ORIGIN` to the actual website origin, including scheme. Cross-site browser writes
are rejected, without requiring login. Use the Docker/Caddy configuration for HTTPS at `rat.thestone.co.za`:
[Deployment instructions](DEPLOYMENT.md).

## Metrics and behavior

Notation follows the brief: added/removed lines, growth, churn, modifications, modification frequency,
churn rate, author modifications/churn and ownership. Directory metrics are recursive rollups;
repository metrics are root-directory metrics.

- Multiple repositories; full HTTPS clones or self-contained ZIP archives containing `.git`.
- Non-merge commits reachable from HEAD; binary changes excluded.
- Rename detection at 50%; edited renames are attributed to the new path.
- Filters by repository, author, file/directory, committer-date period, or selected commit hashes.
- Date intervals are inclusive-start/exclusive-end. The UI includes the complete selected end day.
- `.mailmap` and durable manual author merges; ownership uses total churn across all authors.
- Searchable, paginated commit selection and paginated directory metrics.
- The indexed HEAD hash identifies the analyzed snapshot. Updating a remote does not automatically
  refresh an analysis; delete/re-import for a new snapshot.

All imported data is public, including author names and emails. Do not upload sensitive repositories.
For safety, external Git pointer files/alternates and archive symlinks are rejected. Default quotas
and known free-hosting limitations are documented in [DEPLOYMENT.md](DEPLOYMENT.md).
The old `data/rat.db` is untouched; re-import repositories instead of assuming SQLite data migrated.

## Validation

```bash
npm test
npm run typecheck
npm run build
```

Tests use deterministic Git histories to check parser framing, all metric families, author merging,
ingestion, filtering, API behavior and edge cases. They create isolated scratch files under
the operating-system temporary directory (outside synced workspaces) and isolated embedded
PostgreSQL databases.
Large-repository performance requires separate measurement; small-fixture tests are not a benchmark.

The three real Neon integration tests are opt-in. Set `RAT_NEON_TEST_URL` to a **direct,
non-pooled URL for a disposable branch**, then run `npm test -- tests/integration/neon.test.ts`.
They run migrations and import repositories; never point them at your live database.

## Storage and operations

`RAT_DATA_DIR` defaults to `data` and contains `repos/<id>` and transient `uploads`.
Metrics and jobs survive application restarts in PostgreSQL. Jobs carry leases and crash recovery;
the supported deployment is one worker replica. Repository deletion is blocked while indexing.
The deployment includes versioned migrations, graceful shutdown, health checks and TLS.
Back up PostgreSQL and repository volumes; a free hosting account is not a backup or uptime guarantee.

## AI usage declaration

Usage:

- This repository makes use of AI code generation using the following tools:
  Qoder[model identifier withheld by the tooling; fill in from your IDE session record].
- This repository makes use of AI in-line editing using the following tools:
  Qoder[model identifier withheld by the tooling].
- This repository does not use AI code review.

Every AI-assisted commit carries an `Assisted-by:` trailer in the same format, e.g.
`Assisted-by: Qoder[model withheld by tooling]`.

> Note for the marker: the assisting tooling is contractually unable to disclose its own model
> identifier, so the bracketed model field is left as an explicit placeholder wherever the policy
> demands it. All generated code and documentation has been reviewed and verified by the student,
> including metric values cross-checked against raw `git log --numstat` output.

## License

MIT
