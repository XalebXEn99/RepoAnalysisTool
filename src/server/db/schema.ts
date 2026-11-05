export const MIGRATIONS = [
  {
    version: 1,
    sql: `
CREATE TABLE repositories (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('clone','zip','local')),
  source_url TEXT,
  path TEXT NOT NULL DEFAULT '',
  head_commit TEXT,
  commit_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ingesting','ready','error')),
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ingested_at TIMESTAMPTZ
);
CREATE TABLE authors (
  id SERIAL PRIMARY KEY,
  repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  canonical_id INTEGER,
  merge_source TEXT NOT NULL DEFAULT 'identity',
  UNIQUE (repository_id, name, email)
);
CREATE TABLE commits (
  id SERIAL PRIMARY KEY,
  repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  hash TEXT NOT NULL,
  author_id INTEGER NOT NULL REFERENCES authors(id),
  committer_date BIGINT NOT NULL,
  is_merge INTEGER NOT NULL DEFAULT 0,
  parent_count INTEGER NOT NULL DEFAULT 1,
  subject TEXT NOT NULL DEFAULT '',
  UNIQUE (repository_id, hash)
);
CREATE TABLE objects (
  id SERIAL PRIMARY KEY,
  repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('file','dir')),
  UNIQUE (repository_id,path)
);
CREATE TABLE changes (
  id SERIAL PRIMARY KEY,
  repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  commit_id INTEGER NOT NULL REFERENCES commits(id) ON DELETE CASCADE,
  object_id INTEGER NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  added INTEGER NOT NULL CHECK (added >= 0),
  removed INTEGER NOT NULL CHECK (removed >= 0),
  UNIQUE (commit_id,object_id)
);
CREATE TABLE jobs (
  id SERIAL PRIMARY KEY,
  repository_id INTEGER REFERENCES repositories(id) ON DELETE CASCADE,
  stage TEXT NOT NULL DEFAULT 'queued',
  progress DOUBLE PRECISION NOT NULL DEFAULT 0,
  message TEXT NOT NULL DEFAULT 'waiting for worker',
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','error')),
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until TIMESTAMPTZ,
  worker_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_commits_repo_date ON commits(repository_id,committer_date DESC,id);
CREATE INDEX idx_commits_author ON commits(author_id);
CREATE INDEX idx_authors_canon ON authors(canonical_id);
CREATE INDEX idx_changes_repo_obj ON changes(repository_id,object_id,commit_id);
CREATE INDEX idx_changes_repo_commit ON changes(repository_id,commit_id);
CREATE INDEX idx_jobs_queue ON jobs(status,lease_until,id);
CREATE INDEX idx_jobs_repo ON jobs(repository_id);
CREATE TABLE manual_author_merges (
  repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  source_name TEXT NOT NULL, source_email TEXT NOT NULL,
  target_name TEXT NOT NULL, target_email TEXT NOT NULL,
  PRIMARY KEY(repository_id,source_name,source_email)
);

CREATE TABLE "user" (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  "emailVerified" BOOLEAN NOT NULL DEFAULT false, image TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(), "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE session (
  id TEXT PRIMARY KEY, "expiresAt" TIMESTAMPTZ NOT NULL, token TEXT NOT NULL UNIQUE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(), "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "ipAddress" TEXT, "userAgent" TEXT,
  "userId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
);
CREATE INDEX idx_session_user ON session("userId");
CREATE TABLE account (
  id TEXT PRIMARY KEY, "accountId" TEXT NOT NULL, "providerId" TEXT NOT NULL,
  "userId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "accessToken" TEXT, "refreshToken" TEXT, "idToken" TEXT,
  "accessTokenExpiresAt" TIMESTAMPTZ, "refreshTokenExpiresAt" TIMESTAMPTZ,
  scope TEXT, password TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(), "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE ("providerId","accountId")
);
CREATE INDEX idx_account_user ON account("userId");
CREATE TABLE verification (
  id TEXT PRIMARY KEY, identifier TEXT NOT NULL, value TEXT NOT NULL,
  "expiresAt" TIMESTAMPTZ NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(), "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_verification_identifier ON verification(identifier);
`,
  },
];
