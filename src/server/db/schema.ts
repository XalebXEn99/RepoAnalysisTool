/**
 * SQLite DDL. See IMPLEMENTATION_PLAN.md §4 for the rationale:
 * `changes` materialises per-commit deltas for files AND every ancestor
 * directory, so directory/repository metrics are plain indexed aggregates.
 */
export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA temp_store = MEMORY;
PRAGMA cache_size = -131072;

CREATE TABLE IF NOT EXISTS repositories (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  source_type   TEXT    NOT NULL,             -- 'clone' | 'zip'
  source_url    TEXT,
  path          TEXT    NOT NULL,             -- working copy on disk
  head_commit   TEXT,
  commit_count  INTEGER NOT NULL DEFAULT 0,
  status        TEXT    NOT NULL DEFAULT 'pending', -- pending|ingesting|ready|error
  error         TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  ingested_at   TEXT
);

CREATE TABLE IF NOT EXISTS authors (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  name          TEXT    NOT NULL,
  email         TEXT    NOT NULL,
  canonical_id  INTEGER NOT NULL,             -- authors.id of the merged identity
  merge_source  TEXT    NOT NULL DEFAULT 'identity', -- identity|mailmap|manual
  UNIQUE (repository_id, name, email)
);

CREATE TABLE IF NOT EXISTS commits (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  repository_id  INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  hash           TEXT    NOT NULL,
  author_id      INTEGER NOT NULL REFERENCES authors(id),
  committer_date INTEGER NOT NULL,            -- unix seconds, h[committer-date]
  is_merge       INTEGER NOT NULL DEFAULT 0,
  parent_count   INTEGER NOT NULL DEFAULT 1,
  subject        TEXT    NOT NULL DEFAULT '',
  UNIQUE (repository_id, hash)
);

CREATE TABLE IF NOT EXISTS objects (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  path          TEXT    NOT NULL,             -- '' denotes the repository root
  kind          TEXT    NOT NULL,             -- 'file' | 'dir'
  UNIQUE (repository_id, path)
);

CREATE TABLE IF NOT EXISTS changes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  commit_id     INTEGER NOT NULL REFERENCES commits(id) ON DELETE CASCADE,
  object_id     INTEGER NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  added         INTEGER NOT NULL,             -- l+_{h,o}
  removed       INTEGER NOT NULL,             -- l-_{h,o}
  UNIQUE (commit_id, object_id)
);

CREATE TABLE IF NOT EXISTS jobs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  repository_id INTEGER REFERENCES repositories(id) ON DELETE CASCADE,
  stage         TEXT    NOT NULL DEFAULT '',
  progress      REAL    NOT NULL DEFAULT 0,
  message       TEXT    NOT NULL DEFAULT '',
  status        TEXT    NOT NULL DEFAULT 'queued', -- queued|running|done|error
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_commits_repo_date  ON commits(repository_id, committer_date);
CREATE INDEX IF NOT EXISTS idx_commits_repo_hash  ON commits(repository_id, hash);
CREATE INDEX IF NOT EXISTS idx_commits_author     ON commits(author_id);
CREATE INDEX IF NOT EXISTS idx_objects_repo_path  ON objects(repository_id, path);
CREATE INDEX IF NOT EXISTS idx_authors_repo       ON authors(repository_id);
CREATE INDEX IF NOT EXISTS idx_authors_canon      ON authors(canonical_id);
CREATE INDEX IF NOT EXISTS idx_changes_repo_obj   ON changes(repository_id, object_id, commit_id);
CREATE INDEX IF NOT EXISTS idx_changes_repo_commit ON changes(repository_id, commit_id);
CREATE INDEX IF NOT EXISTS idx_jobs_repo          ON jobs(repository_id);
`;
