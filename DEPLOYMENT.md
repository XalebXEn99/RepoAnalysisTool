# Deploying RAT

## Recommended topology

One Linux server runs Docker Compose: Caddy terminates HTTPS, Express serves the dashboard/API,
and a separate Node process indexes repositories. Neon stores metrics, author identities,
and the durable job queue. A Docker volume stores cloned repositories and uploads.

This is not a Vercel-only deployment: full Git history analysis needs a long-running worker and
persistent filesystem. Vercel can host a frontend, but that would still require this worker server.

## Free hosting caveats

An Oracle Cloud **Always Free eligible** VM is an option, not a guarantee of permanent free capacity
or uptime. Account/card verification is required; capacity can be unavailable and idle instances can
be reclaimed. Check current compute, disk, network and public IP eligibility before provisioning.
Do not accidentally select a paid shape or rely on temporary trial credits.

Choose a home region carefully. A London VM keeps database traffic close to the existing London
Neon project. A VM in South Africa works, but every database round trip crosses regions.
At least 2 GB RAM is recommended; the API and worker have separate memory requirements.
The 1 GB Always Free E2.1.Micro can run a small deployment with 2 GB of persistent swap,
but builds and imports will be slower. Build services serially on that host
(`COMPOSE_PARALLEL_LIMIT=1 docker compose build`), process only one import at a time,
and monitor RAM, swap and disk before increasing the repository limits. Swap is not a
substitute for enough RAM for large histories.

Official references:
- [Oracle Always Free limits](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
- [Neon plans and limits](https://neon.com/pricing)
- [Vercel function limits](https://vercel.com/docs/functions/limitations)

No hosting account, VM, DNS record, or public deployment is created by these repository files.

## 1. Prepare the server

Install Docker Engine 25+ and Docker Compose 2.20.2+ using Docker's instructions for your Linux
distribution. Clone this repository onto the server. Keep SSH access restricted to your IP.
Allow inbound TCP 80 and 443 in BOTH the provider firewall/security list and the operating-system
firewall. Do not expose port 8787 or PostgreSQL to the internet.

## 2. DNS

Create this record when you know your server's public address:

| Type | Host/name | Value |
|---|---|---|
| A | `rat` | Your VM's public IPv4 address |

Use an AAAA record only if IPv6 actually works. Do not publish a CNAME to Neon: Neon is the database,
not the website. A CNAME is only appropriate if your eventual host provides a canonical hostname.
Remove conflicting records for `rat`. Caddy obtains and renews the TLS certificate automatically.

## 3. Environment

Create `.env.local` on the server from `.env.example`. The local development `.env.local` already
contains the Neon URLs; transfer secrets securely rather than committing or pasting them into chat.

Required:

```dotenv
DATABASE_URL=your-pooled-Neon-connection-string
DATABASE_URL_UNPOOLED=your-direct-Neon-connection-string
RAT_APP_ORIGIN=https://rat.thestone.co.za
```

Restrict `.env.local` file permissions (`chmod 600 .env.local` on Linux).
Keep the SSL parameters provided by Neon. Never use a `VITE_` prefix for secrets.

`RAT_APP_ORIGIN` must exactly match the browser's origin. For local Vite development it is
`http://localhost:5173`, not the API port. The production reverse proxy and API share one origin.
There is no sign-in, administrator account, or registration. Browser writes from other origins
are rejected; API clients without an Origin header can use the same public endpoints.

The default driver uses PostgreSQL TCP on port 5432. For networks blocking that port,
`RAT_DATABASE_TRANSPORT=websocket` selects the Neon driver using WebSocket connections on
port 443. If WebSockets are also blocked, `RAT_DATABASE_TRANSPORT=http` explicitly uses
Neon's HTTPS queries for normal API/worker traffic, with a 60-second request timeout.
HTTP is for stateless statements, not sessions: migrations still use direct PostgreSQL TCP
and must run from a network that permits it. This is not an automatic fallback that masks errors.
Verify database-backed pages and anonymous URL/ZIP ingestion before treating the application as ready.

## 4. Build and start

From the repository directory on the Linux server:

```bash
docker compose build
docker compose run --rm migrate
docker compose up -d
docker compose ps
curl --fail https://rat.thestone.co.za/api/health
```

The visible **+** button opens the URL/ZIP import page for everyone; no credentials are needed.
Dashboard, Repositories, and Authors have theme-specific pixel-art science board, rat cage,
and lab coat icons.
Settings expands the palette swatches and pixel-font switch; palette names remain available
as accessible labels and tooltips.

Compose runs versioned migrations before API/worker startup. Migrations use
`DATABASE_URL_UNPOOLED`; normal traffic uses a small pooled connection pool.

## 5. Verify the whole application

1. Open the domain in a fresh browser without signing in.
2. Import a small public HTTPS repository and a ZIP containing `.git`, and follow progress.
3. Confirm dashboard filters and author merging work.
4. Verify another anonymous browser can use the import controls and browse the resulting analysis.
5. Restart the API and worker and verify indexed metrics remain available.
6. During an import, load existing metrics from another browser to confirm the API stays responsive.

**This is a shared, anonymous workspace: anyone can import, merge authors, or delete finished
analyses. All indexed repositories, metrics, author names and emails are publicly visible.**
Do not upload private/sensitive repositories or treat the shared analyses as permanent storage. GitHub's ordinary
"Download ZIP" does not contain `.git`; use a self-contained repository archive with its history.
External `.git` pointer files, object alternates, and archive symlinks are deliberately rejected.

## Limits and failure recovery

- One worker processes one job at a time; deploy one worker replica with this Compose topology.
- Jobs are claimed atomically and carry renewable two-minute leases. Interrupted jobs can restart
  from scratch, up to three attempts. Deterministic import errors are recorded rather than endlessly
  retried. Failed imports can be deleted and resubmitted.
- The API wakes the worker through their shared volume. Idle queue recovery scans run every ten
  minutes, not every few seconds, so queue polling does not keep Neon awake continuously. A crashed
  job can therefore take up to about ten minutes to be reclaimed by another idle worker.
- Default limits: 10 repositories, 100 MiB upload, 1 GiB extracted/clone storage per repository,
  100,000 archive entries, ten-minute Git subprocess timeout, 32 MiB individual parsed commit.
  Disk quota checks during cloning are periodic, so leave disk headroom.
- Public clone hosts default to GitHub, GitLab and Bitbucket, HTTPS only, no embedded credentials.
- These safety limits can prevent very large repositories from importing. Increase only after
  measuring available RAM, disk, Neon storage and import duration. A 100k-commit benchmark is not
  implied by a successful small-fixture test.
- Existing working copies are retained, but this release does not provide incremental refresh.
  Delete and re-import to analyze a newer HEAD.

Watch logs with `docker compose logs -f api worker`. Keep a Neon storage/compute budget and monitor
disk space. Free quotas are finite; directory rollups produce more change rows than file deltas alone.

## Backups, updates, and persistence

Use the direct URL with `pg_dump` and test a restore to a separate database/Neon branch.
Back up the `rat-data` Docker volume if uploaded source archives/working copies need to survive a VM
loss. A Docker volume survives container restarts, not destruction of the VM's disk.
Never use `docker compose down -v` unless you deliberately want to delete local repository storage.

Before upgrading, back up PostgreSQL and test migrations on a Neon branch. Then pull the code and run:

```bash
docker compose up -d --build
```

PostgreSQL is the source of truth for completed analyses. The old SQLite database is not imported
automatically or modified; re-import repositories through the **+** import page.
