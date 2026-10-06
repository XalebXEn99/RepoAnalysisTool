# Repo Analysis Tool (RAT) — Implementation Plan

> **Status:** living document. Updated as implementation progresses.
> **Sources of truth:** [`test_brief.pdf`](./test_brief.pdf) and its faithful extraction
> [`test_brief.md`](./test_brief.md). Documentation conventions follow
> [`ai_policy.pdf`](./ai_policy.pdf).

---

## 1. Goals

Build a **local-first web application** that ingests git repositories (zip upload or remote URL deep
clone) and computes, filters and visualises the metric families defined in the brief:

1. **File metrics** — added lines, removed lines, growth, churn.
2. **Directory metrics** — the same four quantities rolled up over immediate children (recursively).
3. **Repository metrics** — directory metrics evaluated at the root of the commit tree.
4. **Commit-set metrics** — added/removed/growth/churn over a commit set, plus modifications
   $n_{H,o}$, modification frequency $\eta_{H,o}$ and churn rate $\rho_{H,o}$.
5. **Author metrics** — author modifications $n_{H,o,a}$, author churn $\lambda_{H,o,a}$ and
   ownership $\omega_{H,o,a}$.

The dashboard must be filterable by **repository**, **author**, **file or directory**, and **commit
set** (a time period or a manually selected list of commits). Repositories are managed in bulk
(multi-repo support) and authors can be merged via `.mailmap` or manually.

### Non-goals for the MVP

- Fancy styling (a clean, functional UI ships first; styling is a later joint pass).
- Hosted/remote deployment — the app is intentionally clonable and fully local.
- Test suite in the first pass (the testing dependency is installed up front, tests are written once
  the MVP works, per project instruction).

---

## 2. Technology choices and rationale

| Concern | Choice | Rationale |
| --- | --- | --- |
| Language | TypeScript everywhere | One language across server, client and tests; the metric formulas are precise and types keep them honest. |
| Backend | Node 18 + Express | Trivial to run locally (`npm install && npm run dev`), no external services. |
| Database | SQLite via `better-sqlite3` (file at `data/rat.db`) | Local by design (clonable repo, no server DB). Synchronous API = simple, fast bulk ingestion; indexed aggregates answer every dashboard query. |
| Git access | Shell out to the system `git` binary, streaming `git log` | Git's own diff engine implements binary detection and 50% rename detection exactly as the brief demands; re-implementing diffing would be slower and wrong. |
| Zip ingestion | `extract-zip` (streaming, zip-slip safe) | Handles large repo zips without loading them into memory. |
| Frontend | React 18 + Vite | Fast dev loop, small clean component UI. |
| Charts | Recharts | Declarative SVG charts for churn/ownership visualisation. |
| Tests | Vitest | Same toolchain as Vite; installed now, test files written after the MVP. |

**Storage decision.** The brief's "file storage" question is answered with the **local filesystem +
SQLite**, not browser storage: a clone of `git/git` is hundreds of MB and ~100k commits, which no
browser quota can hold, and the artefact must be a clonable repo whose data lives on the machine that
runs it. Layout:

```text
data/                  # gitignored, created at runtime
├── rat.db             # SQLite database (all metrics, authors, jobs)
├── repos/<repoId>/    # one working copy per ingested repository (clone or unzip target)
└── uploads/           # transient zip uploads while extracting
```

---

## 3. Metric semantics (as implemented)

All definitions are taken from [`test_brief.md`](./test_brief.md) §2. Implementation notes that are
not obvious from the formulae:

- **Commit universe.** $\bar{H}$ = non-merge commits reachable from the reference commit (HEAD by
  default). Merge commits are excluded from every metric (`git log --no-merges`).
- **Previous commit.** $h[p]$ is the single first parent; the initial commit diffs against the empty
  tree, so its files are pure additions. `git log` produces exactly this.
- **Binary files.** Excluded from measurement. Detected by git itself: `--numstat` reports
  `-\t-\tpath` for binary blobs.
- **Renames.** Detected at a 50% threshold (`-M50%`). Changes are attributed to the **new** path; a
  pure rename contributes zero line deltas, so metrics are unchanged — matching the brief.
- **Deletions.** A file present in $h[p]$ but not $h$ contributes its removed lines on its (old) path.
- **Directory rollup.** Because $l^{+}_{h,d}$ is defined recursively over immediate children, it is
  equivalent to "sum of $l^{+}_{h,f}$ over every file $f$ at or below $d$". The engine therefore
  materialises, per changed file and per commit, one delta row for the file **and one for each
  ancestor directory** (including the root `""`). Repository metrics are then simply the root row.
  This makes every later query an indexed `SUM ... GROUP BY` — no re-walking of trees at request time.
- **Commit sets.** $H_t$ and $H_{i,j}$ filter on **committer date** (UNIX seconds), inclusive/exclusive
  exactly as defined. A manual commit list filters on commit hash.
- **Modifications.** $n_{H,o}$ counts commits whose churn on $o$ is $>0$; with one materialised row
  per (commit, object) this is a filtered `COUNT`.
- **Authors.** Each raw `(name, email)` pair is an author row. `.mailmap` (read via
  `git check-mailmap`) and manual merges map rows onto a canonical author; metrics group by the
  canonical id, so $\mathbb{I}(a,h)$ is an equality test on canonical ids.

---

## 4. Database schema

```sql
repositories(id, name, source_type, source_url, path, head_commit, commit_count,
             status, error, created_at, ingested_at)
authors(id, repository_id, name, email, canonical_id, source)   -- canonical_id: mailmap/manual merge
commits(id, repository_id, hash, author_id, committer_date, is_merge, parent_count)
objects(id, repository_id, path, kind)                          -- kind: 'file' | 'dir'
changes(id, repository_id, commit_id, object_id, added, removed) -- materialised per-commit deltas,
                                                                 -- files AND ancestor directories
jobs(id, repository_id, stage, progress, message, status, created_at, updated_at)
```

Indexes: `commits(repository_id, committer_date)`, `commits(repository_id, hash)`,
`changes(repository_id, object_id, commit_id)`, `changes(repository_id, commit_id)`,
`authors(repository_id)`, `objects(repository_id, path)`.

**Why materialise directory rollups at ingest:** a query for "churn of `src/` between dates D1..D2 by
author" becomes a single indexed aggregate instead of re-diffing or re-walking the tree per request —
this is what keeps ~100k-commit repositories responsive (rubric: Architecture & Usability tiers).

---

## 5. Ingestion pipeline

```text
zip upload ──► save to data/uploads ──► extract-zip ──┐
clone URL  ──► git clone (full/deep) ────────────────┤
                                                     ▼
                                  data/repos/<id>/  (working copy with .git)
                                                     ▼
                    git check-mailmap  ──► canonical author mapping
                                                     ▼
        git log --no-merges --numstat -M50% -z --pretty=<record format>
                                                     ▼  (streaming parser)
                    per commit: authors, committer date, per-file (+,-,path,rename)
                                                     ▼
                    expand each file delta to ancestor directories (rollup)
                                                     ▼
              batched SQLite inserts inside transactions (jobs table tracks progress)
```

Parser details: `-z` gives NUL-separated, unquoted paths and `old\0new\0` pairs for renames, which is
the only unambiguous way to parse paths containing spaces/newlines. Records are delimited by a custom
`--pretty=format:` sentinel so commit metadata and numstat blocks never mix.

---

## 6. HTTP API (v1)

| Method & path | Purpose |
| --- | --- |
| `GET /api/health` | liveness |
| `GET /api/repos` | list repositories + ingest status |
| `POST /api/repos/clone` | `{ url }` → queue clone+ingest job |
| `POST /api/repos/upload` | multipart/zip stream → queue extract+ingest job |
| `GET /api/repos/:id` | repository detail |
| `DELETE /api/repos/:id` | remove repo, working copy and rows |
| `GET /api/repos/:id/jobs` | ingestion progress |
| `GET /api/repos/:id/authors` | authors with canonical grouping |
| `POST /api/repos/:id/authors/merge` | `{ sourceIds, targetId }` manual merge → recompute grouping |
| `GET /api/repos/:id/objects?kind=&prefix=` | file/directory browser (for filters) |
| `GET /api/repos/:id/commits?from=&to=&limit=` | commit list (for manual commit-set selection) |
| `GET /api/metrics/summary?repo=&from=&to=&author=&commits=` | repository-level (root) metrics + timeline |
| `GET /api/metrics/object?repo=&path=&from=&to=&author=&commits=` | metrics for one file/dir + per-author ownership |
| `GET /api/metrics/children?repo=&path=&...` | table of immediate children metrics (dir/repo browsing) |
| `GET /api/metrics/top?repo=&by=churn&limit=&...` | top-N files/dirs for charts |

All metric endpoints accept the same filter set: `repo`, `author`, `path`, `from`/`to` (UNIX or ISO),
`commits` (comma-separated hashes). This mirrors the brief's four filter dimensions directly.

---

## 7. Repository layout

```text
RepoAnalysisTool/
├── ai_policy.pdf                 # source of truth (policy)
├── test_brief.pdf                # source of truth (metrics)
├── test_brief.md                 # extracted brief with LaTeX
├── IMPLEMENTATION_PLAN.md        # this document
├── README.md                     # living doc + AI declarations (policy §Code)
├── package.json / tsconfig*.json / vite.config.ts
├── data/                         # runtime-only, gitignored
├── src/
│   ├── shared/types.ts           # API contract shared by client & server
│   ├── server/
│   │   ├── index.ts              # express bootstrap, static serving, job worker
│   │   ├── config.ts             # paths, ports
│   │   ├── db/connection.ts      # sqlite open + pragmas
│   │   ├── db/schema.ts          # DDL + indexes
│   │   ├── ingest/gitSource.ts   # clone / unzip into data/repos
│   │   ├── ingest/gitLogParser.ts# streaming `git log` parser (rename/binary safe)
│   │   ├── ingest/mailmap.ts     # git check-mailmap wrapper
│   │   ├── ingest/ingestionService.ts # orchestrates pipeline + jobs
│   │   ├── metrics/queryEngine.ts# filters → commit set → SQL aggregates
│   │   ├── jobs/jobManager.ts    # serial job queue with progress
│   │   └── routes/*.ts           # repos / authors / metrics / commits
│   └── client/
│       ├── index.html, main.tsx, App.tsx
│       ├── api/client.ts         # typed fetch wrapper
│       ├── components/           # Layout, FilterBar, MetricCard, MetricTable,
│       │                         # AuthorTable, ChurnChart
│       ├── pages/                # Dashboard, Repositories, AddRepo, Authors, Commits
│       └── styles/global.css     # clean minimal styling
├── tests/                        # vitest suites (written after MVP)
└── docs/                         # architecture/mermaid/usage/db docs (added last)
```

---

## 8. Delivery phases

| # | Phase | Exit criteria |
| --- | --- | --- |
| 1 | Extraction & scaffold | `test_brief.md` faithful; deps installed; dev servers boot. |
| 2 | Storage & ingestion | Clone URL and zip both produce a populated DB; job progress visible. |
| 3 | Metric engine | All five metric families returned by the API; values match ground-truth `git log --numstat` on a synthetic repo (renames, deletes, binary, merges, mailmap). |
| 4 | Dashboard UI | Repo/author/object/commit-set filters wired; tables + charts render. |
| 5 | Author merging | `.mailmap` applied automatically; manual merge recomputes author metrics. |
| 6 | Verification | Spot-check against cJSON (and Redis/git where time allows) at pinned commits. |
| 7 | README + push | README current; AI declarations per policy; pushed to Gitea `Xaleb/RepoAnalysisTool`. |
| 8 | `docs/` | Mermaid architecture/ER/flow diagrams, usage guide, dependency list, DB notes. |
| 9 | Tests | Vitest suites for parser, rollup and metric formulas; fixtures committed. |

---

## 9. Risks & mitigations

- **Parser correctness on odd paths** (spaces, unicode, renames): `-z` + sentinel record format;
  fixture repos cover each case.
- **Huge repos (git/git ≈ 70k+ commits, Redis ≈ 100k+)**: streaming parse + batched transactions;
  directory rollup costs O(changed-files × path-depth) once at ingest, never per request.
- **Zip-slip / malicious archives**: `extract-zip` validates entry paths; extraction happens in an
  isolated temp dir.
- **SQLite write locking during ingest**: single serial job queue; WAL mode for concurrent reads.
- **Metric drift vs the brief**: every formula is implemented in one place
  (`metrics/queryEngine.ts`) and cross-checked against raw git output in tests.

---

*This document was planned and generated with the assistance of: Qoder (model identifier withheld by
the tooling — see [`README.md`](./README.md) for the repository-level AI declaration required by
[`ai_policy.pdf`](./ai_policy.pdf)).*
