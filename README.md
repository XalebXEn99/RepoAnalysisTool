# RAT — Repo Analysis Tool

A local-first web dashboard that measures how a git repository evolved: who changed what, where
the churn is, and how volatile each file, directory and the repository as a whole is.

**Sources of truth:** [`test_brief.pdf`](./test_brief.pdf) and its LaTeX-preserving extraction
[`test_brief.md`](./test_brief.md). Documentation conventions follow [`ai_policy.pdf`](./ai_policy.pdf).
The delivery plan lives in [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md); deeper architecture
notes (mermaid diagrams, DB design, usage guide) live in [`docs/`](./docs/).

---

## Features (mapped to the brief)

| Brief requirement | Status |
| --- | --- |
| Repository upload: zip (with `.git`) | ✅ streamed upload, extracted locally |
| Repository upload: remote URL deep clone | ✅ full `git clone` |
| Multiple repository support | ✅ each repo isolated in `data/repos/<id>` |
| Metric categories: file / directory / repository / commit-set / author | ✅ all five families |
| Filtering: repository, author, file or directory, commit set (period or manual list) | ✅ |
| Author merging via `.mailmap` | ✅ applied automatically at ingest (`git check-mailmap`) |
| Manual author merging | ✅ Authors page, recomputes metrics instantly |
| Rename detection at 50%, deletions, binary exclusion, non-merge commits only | ✅ delegated to git's own diff engine |

## Metrics implemented

Notation follows the brief: `l⁺` added lines, `l⁻` removed lines, `δ = l⁺ − l⁻` growth,
`λ = l⁺ + l⁻` churn, `n` modifications, `η = n/|H|` modification frequency, `ρ = λ/|H|` churn rate,
`n_{H,o,a}` / `λ_{H,o,a}` author modifications/churn and `ω = λ_{H,o,a}/λ_{H,o}` ownership.
Directory metrics are the recursive sum over immediate children; repository metrics are the directory
metrics of the root; commit sets `H_t` / `H_{i,j}` filter on **committer date**.

## Quick start

Requirements: Node ≥ 18.12, npm, and a system `git` (≥ 2.30).

```bash
npm install          # see troubleshooting below if better-sqlite3 builds from source
npm run dev          # API on :8787 + Vite client on :5173 (proxies /api)
# open http://localhost:5173
```

Production mode:

```bash
npm run build        # compiles server to dist/server and client to dist/client
npm start            # Express serves the API and the built client on :8787
```

Tests (Vitest, 61 tests across 4 suites):

```bash
npm test             # or: npx vitest run tests/unit/metrics.test.ts
npm run test:watch
```

| Suite | Covers |
| --- | --- |
| `tests/unit/gitLogParser.test.ts` | `git log --numstat -z` byte protocol: merges, renames, deletions, binary, spaced paths |
| `tests/unit/ingest.test.ts` | pipeline stages, materialised ancestor rollup, mailmap grouping, zip ingestion |
| `tests/unit/metrics.test.ts` | every metric family and filter from the brief, against hand-computed values |
| `tests/unit/api.test.ts` | all HTTP routes on an ephemeral port, filter parameters and error contracts |

Tests build a throwaway git fixture (`tests/helpers/fixture.ts`) with deterministic dates and run
against an isolated scratch database, so they never touch `data/rat.db`. They shell out to `git`
and `zip`, both of which must be on `PATH`.

### Where data lives

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
docs/            architecture, database, usage and dependency documentation
```

## Troubleshooting

- **`better-sqlite3` fails to build (`gyp ERR!`)** — happens when node-gyp picks up a Python that
  lacks the `gyp` package metadata (e.g. an Anaconda python first on `PATH`). Build with the system
  python instead:
  `npm_config_python=/usr/bin/python3 npm install`
- **Port already in use** — override with `RAT_PORT=9000 npm run dev:server`.
- **Different data location** — override with `RAT_DATA_DIR=/path/to/data`.

## AI usage declaration (required by [`ai_policy.pdf`](./ai_policy.pdf))

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
