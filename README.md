# RAT — Repo Analysis Tool

A local-first web dashboard that measures how a git repository evolved: who changed what, where the
churn is, and how volatile each file, directory and the repository as a whole is.

## Clone and run

Requirements: Node >= 18.12, npm, and a system `git` (>= 2.30). The test suite also needs `zip`.

```bash
git clone https://sdp.ms.wits.ac.za/Xaleb/RepoAnalysisTool.git
cd RepoAnalysisTool
npm install
npm run dev
```

Then open http://localhost:5173. `npm run dev` starts both processes: the Express API on :8787 and
the Vite client on :5173, which proxies `/api` to the API.

Production mode, where Express serves the built client and Vite is not involved:

```bash
npm run build
npm start            # http://localhost:8787
```

The first run creates `data/` (the SQLite database plus the working copies of ingested repositories)
and starts empty. Add a repository from the UI: either a zip that contains `.git`, or a remote URL to
deep clone. Everything stays on the local machine.

If `npm install` fails while building `better-sqlite3` (`gyp ERR!`), point node-gyp at the system
Python and retry: `npm_config_python=/usr/bin/python3 npm install`. More in
[Troubleshooting](#troubleshooting).

---

Everything below is additional detail.

## What it measures

Notation follows the brief: `l⁺` added lines, `l⁻` removed lines, `δ = l⁺ − l⁻` growth,
`λ = l⁺ + l⁻` churn, `n` modifications, `η = n/|H|` modification frequency, `ρ = λ/|H|` churn rate,
`n_{H,o,a}` / `λ_{H,o,a}` author modifications and churn, and `ω = λ_{H,o,a}/λ_{H,o}` ownership.
Directory metrics are the recursive sum over their contents; repository metrics are the directory
metrics of the root; commit sets `H_t` and `H_{i,j}` filter on **committer date**. Binary files are
excluded from every measurement, renames are detected at 50% and attributed to the new path, and
`H` contains non-merge commits only.

The assignment brief this implements, including all formulae, is [`docs/test_brief.md`](./docs/test_brief.md).

## Features

| Brief requirement | Implementation |
| --- | --- |
| Repository upload: zip containing `.git` | streamed to `data/uploads`, extracted, rejected if no `.git` |
| Repository upload: remote URL | full `git clone` (no shallow depth) into `data/repos/<id>` |
| Multiple repositories | each isolated on disk and scoped by `repository_id` in the database |
| File, directory, repository, commit-set and author metrics | all five families in `src/server/metrics/queryEngine.ts` |
| Filtering by repository, author, file or directory, commit set | filter bar plus query parameters on `/api/metrics/*` |
| Author merging via `.mailmap` | applied at ingest through `git check-mailmap` |
| Manual author merging | Authors page; metrics recompute immediately because aggregates join on `canonical_id` |
| Renames, deletions, binary exclusion, non-merge commits | delegated to git's own diff engine (`--numstat -z -M50% --no-merges`) |

Ingest runs as a serial background job that publishes progress to the `jobs` table, so the UI can
show stage and percentage while a large repository is indexed.

## Tests

Vitest, 86 tests across 5 suites:

```bash
npm test             # or: npx vitest run tests/unit/metrics.test.ts
npm run test:watch
npm run typecheck
```

| Suite | Covers |
| --- | --- |
| `tests/unit/gitLogParser.test.ts` | `git log --numstat -z` byte protocol: merges, renames, deletions, binary, spaced paths |
| `tests/unit/ingest.test.ts` | pipeline stages, materialised ancestor rollup, mailmap grouping, zip ingestion |
| `tests/unit/metrics.test.ts` | every metric family and filter from the brief, against hand-computed values |
| `tests/unit/api.test.ts` | all HTTP routes on an ephemeral port, filter parameters and error contracts |
| `tests/unit/edgeCases.test.ts` | pathological repositories: no commits, file-less commits, binary-only history, awkward paths, a file that becomes a directory, re-ingestion, cascade deletion, `PRAGMA integrity_check` |

Tests build a throwaway git fixture (`tests/helpers/fixture.ts`) with deterministic dates and run
against an isolated scratch database, so they never touch `data/rat.db`. They shell out to `git` and
`zip`, both of which must be on `PATH`.

## Where data lives

Everything is local to the machine — nothing is uploaded anywhere and no external database is used:

```text
data/rat.db            SQLite database (repositories, authors, commits, objects, changes, jobs)
data/repos/<id>/       working copy of each ingested repository (clone or unzipped upload)
data/uploads/          transient zip uploads (deleted after extraction)
data/test-tmp/         scratch fixtures and databases created by `npm test`
```

`data/` is gitignored, so a fresh clone of this repository starts empty.

## Repository layout

```text
src/shared/      API contract types shared by client and server
src/server/      Express API: app.ts, db/, ingest/, metrics/, jobs/, routes/
src/client/      React + Vite dashboard: lib/, components/, pages/, styles/
tests/           Vitest suites and the deterministic git fixture
docs/            the assignment brief (test_brief.md)
```

[`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) records the delivery plan, the database design
rationale and the metric-to-SQL mapping.

## Troubleshooting

- **`better-sqlite3` fails to build (`gyp ERR!`)** — happens when node-gyp picks up a Python that
  lacks the `gyp` package metadata (e.g. an Anaconda python first on `PATH`). Build with the system
  python instead:
  `npm_config_python=/usr/bin/python3 npm install`
- **Port already in use** — override with `RAT_PORT=9000 npm run dev:server`. Vite then needs
  `server.proxy` in `vite.config.ts` pointed at the same port.
- **Different data location** — override with `RAT_DATA_DIR=/path/to/data`.
- **A repository was ingested before a parser fix** — its commit counts can be stale; delete it from
  the Repositories page and add it again to re-index from scratch.

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
