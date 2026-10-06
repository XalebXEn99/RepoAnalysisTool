import fs from 'node:fs';
import { db } from '../db/connection';
import type { JobHandle } from '../jobs/jobManager';
import { parseGitLog, runGitLog } from './gitLogParser';
import { formatIdent, resolveMailmap, type AuthorIdent } from './mailmap';
import {
  cloneRepository,
  extractRepositoryZip,
  headCommit,
  listAuthorIdents,
  locateRepoRoot,
} from './gitSource';

/** Commits inserted per transaction/event-loop yield (keeps UI responsive). */
const CHUNK = 1000;

interface RepoRow {
  id: number;
  name: string;
  source_type: string;
  source_url: string | null;
  path: string;
}

function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** A manual author merge, keyed by identity so that it survives a re-ingest. */
interface ManualMerge {
  sourceName: string;
  sourceEmail: string;
  targetName: string;
  targetEmail: string;
}

function readManualMerges(repoId: number): ManualMerge[] {
  return db()
    .prepare(
      `SELECT s.name AS sourceName, s.email AS sourceEmail, t.name AS targetName, t.email AS targetEmail
       FROM authors s JOIN authors t ON t.id = s.canonical_id
       WHERE s.repository_id = ? AND s.merge_source = 'manual' AND s.id <> s.canonical_id`,
    )
    .all(repoId) as ManualMerge[];
}

/**
 * Drops every row derived from a previous ingest, so re-ingesting a repository
 * (or retrying one whose ingest was interrupted) replaces the data instead of
 * duplicating it and tripping UNIQUE(repository_id, hash).
 */
function clearIngestedData(repoId: number): void {
  const database = db();
  database.transaction(() => {
    database.prepare('DELETE FROM changes WHERE repository_id = ?').run(repoId);
    database.prepare('DELETE FROM commits WHERE repository_id = ?').run(repoId);
    database.prepare('DELETE FROM objects WHERE repository_id = ?').run(repoId);
    database.prepare('DELETE FROM authors WHERE repository_id = ?').run(repoId);
    database.prepare('UPDATE repositories SET head_commit = NULL, commit_count = 0 WHERE id = ?').run(repoId);
  })();
}

/**
 * Re-applies the user's manual author merges after the author rows have been
 * rebuilt. Identities that no longer occur in the history are skipped.
 */
function restoreManualMerges(repoId: number, merges: ManualMerge[]): void {
  if (merges.length === 0) return;
  const database = db();
  const findRow = database.prepare(
    'SELECT id, canonical_id FROM authors WHERE repository_id = ? AND name = ? AND email = ?',
  );
  const apply = database.prepare(
    `UPDATE authors SET canonical_id = ?, merge_source = 'manual'
     WHERE repository_id = ? AND (id = ? OR canonical_id = ?)`,
  );
  database.transaction(() => {
    for (const merge of merges) {
      const source = findRow.get(repoId, merge.sourceName, merge.sourceEmail) as { id: number } | undefined;
      const target = findRow.get(repoId, merge.targetName, merge.targetEmail) as
        | { id: number; canonical_id: number }
        | undefined;
      if (!source || !target || source.id === target.id) continue;
      apply.run(target.canonical_id, repoId, source.id, source.id);
    }
  })();
}

/**
 * Full ingestion pipeline for one repository:
 *   source (clone | unzip) -> mailmap -> git log parse -> materialised deltas.
 * See IMPLEMENTATION_PLAN.md §5.
 */
export async function ingestRepository(repoId: number, handle: JobHandle): Promise<void> {
  const database = db();
  const repo = database.prepare('SELECT * FROM repositories WHERE id = ?').get(repoId) as RepoRow | undefined;
  if (!repo) throw new Error(`repository ${repoId} does not exist`);
  database.prepare(`UPDATE repositories SET status = 'ingesting', error = NULL WHERE id = ?`).run(repoId);
  // Start from a clean slate; the user's manual merges are carried across.
  const manualMerges = readManualMerges(repoId);
  clearIngestedData(repoId);

  // ---- stage 1: obtain a working copy that contains .git -------------------
  let repoPath = repo.path;
  if (repo.source_type === 'local') {
    // Working copy already on disk (used by tests and local-path ingestion).
    handle.update('prepare', 0.05, 'using existing working copy');
  } else if (repo.source_type === 'zip') {
    handle.update('extract', 0.05, 'extracting uploaded zip');
    const zipPath = repo.source_url;
    if (!zipPath || !fs.existsSync(zipPath)) throw new Error('uploaded zip is missing');
    await extractRepositoryZip(zipPath, repoPath);
    fs.rmSync(zipPath, { force: true });
    const root = locateRepoRoot(repoPath);
    if (!root) throw new Error('zip contains no .git directory (the brief requires one)');
    repoPath = root;
    database.prepare('UPDATE repositories SET path = ? WHERE id = ?').run(repoPath, repoId);
  } else {
    handle.update('clone', 0.05, `cloning ${repo.source_url}`);
    if (!repo.source_url) throw new Error('clone repository has no source url');
    cloneRepository(repo.source_url, repoPath);
  }
  if (!locateRepoRoot(repoPath)) throw new Error('working copy has no .git directory');

  // ---- stage 2: authors and .mailmap --------------------------------------
  handle.update('authors', 0.15, 'resolving author identities');
  const rawIdents = listAuthorIdents(repoPath);
  const mailmap = resolveMailmap(repoPath, rawIdents);

  const findAuthor = database.prepare('SELECT id FROM authors WHERE repository_id = ? AND name = ? AND email = ?');
  const insertAuthor = database.prepare(
    `INSERT INTO authors (repository_id, name, email, canonical_id, merge_source)
     VALUES (?, ?, ?, 0, 'identity')`,
  );
  const setCanonical = database.prepare('UPDATE authors SET canonical_id = ?, merge_source = ? WHERE id = ?');

  const ensureAuthorRow = (ident: AuthorIdent): number => {
    const existing = findAuthor.get(repoId, ident.name, ident.email) as { id: number } | undefined;
    if (existing) return existing.id;
    const info = insertAuthor.run(repoId, ident.name, ident.email);
    const id = Number(info.lastInsertRowid);
    setCanonical.run(id, 'identity', id);
    return id;
  };

  const canonicalOf = new Map<string, AuthorIdent>();
  for (const raw of rawIdents) {
    canonicalOf.set(formatIdent(raw), mailmap.get(formatIdent(raw)) ?? raw);
  }
  // Canonical identities get their row first (placeholder rows when the
  // mailmap target never authored a commit itself).
  const canonicalRowId = new Map<string, number>();
  for (const canonical of canonicalOf.values()) {
    const key = formatIdent(canonical);
    if (!canonicalRowId.has(key)) {
      const id = ensureAuthorRow(canonical);
      if (!rawIdents.some((r) => formatIdent(r) === key)) {
        setCanonical.run(id, 'mailmap', id); // placeholder target identity
      }
      canonicalRowId.set(key, id);
    }
  }
  const authorIdByRaw = new Map<string, number>();
  for (const raw of rawIdents) {
    const rawKey = formatIdent(raw);
    const rowId = ensureAuthorRow(raw);
    const canonical = canonicalOf.get(rawKey)!;
    const canonId = canonicalRowId.get(formatIdent(canonical))!;
    setCanonical.run(canonId, rawKey === formatIdent(canonical) ? 'identity' : 'mailmap', rowId);
    authorIdByRaw.set(`${raw.name}\u0000${raw.email}`, rowId);
  }
  restoreManualMerges(repoId, manualMerges);

  // ---- stage 3: history -> commits, objects, changes ----------------------
  handle.update('history', 0.2, 'reading git history (git log --numstat)');
  const logBuffer = runGitLog(repoPath);
  handle.update('history', 0.3, 'parsing history');
  const commits = parseGitLog(logBuffer);

  const objectIdByPath = new Map<string, number>();
  const findObject = database.prepare('SELECT id FROM objects WHERE repository_id = ? AND path = ?');
  const insertObject = database.prepare('INSERT INTO objects (repository_id, path, kind) VALUES (?, ?, ?)');
  const promoteToDir = database.prepare(`UPDATE objects SET kind = 'dir' WHERE id = ? AND kind <> 'dir'`);
  const knownDirs = new Set<number>();
  const ensureObject = (objectPath: string, kind: 'file' | 'dir'): number => {
    let id = objectIdByPath.get(objectPath);
    if (id === undefined) {
      const existing = findObject.get(repoId, objectPath) as { id: number } | undefined;
      id = existing ? existing.id : Number(insertObject.run(repoId, objectPath, kind).lastInsertRowid);
      objectIdByPath.set(objectPath, id);
    }
    // A path can be a file in one commit and a directory in a later one (or the
    // other way round). Directories win so the path stays browsable; a kind is
    // never demoted, because the file rows are what carry the deltas.
    if (kind === 'dir' && !knownDirs.has(id)) {
      promoteToDir.run(id);
      knownDirs.add(id);
    }
    return id;
  };
  ensureObject('', 'dir'); // the repository root (docs/test_brief.md §2.2)

  /** Ids of the file object plus every ancestor directory, root included. */
  const ancestorChainCache = new Map<string, number[]>();
  const objectChainFor = (filePath: string): number[] => {
    const cached = ancestorChainCache.get(filePath);
    if (cached) return cached;
    const chain: number[] = [ensureObject(filePath, 'file')];
    const parts = filePath.split('/');
    for (let depth = parts.length - 1; depth >= 1; depth -= 1) {
      chain.push(ensureObject(parts.slice(0, depth).join('/'), 'dir'));
    }
    chain.push(objectIdByPath.get('')!);
    ancestorChainCache.set(filePath, chain);
    return chain;
  };

  const insertCommit = database.prepare(
    `INSERT INTO commits (repository_id, hash, author_id, committer_date, is_merge, parent_count, subject)
     VALUES (?, ?, ?, ?, 0, ?, ?)`,
  );
  const insertChange = database.prepare(
    'INSERT INTO changes (repository_id, commit_id, object_id, added, removed) VALUES (?, ?, ?, ?, ?)',
  );

  const insertChunk = database.transaction((slice: typeof commits) => {
    for (const commit of slice) {
      const authorId = authorIdByRaw.get(`${commit.authorName}\u0000${commit.authorEmail}`);
      if (authorId === undefined) continue; // cannot happen: idents came from the same log
      const commitRow = insertCommit.run(
        repoId,
        commit.hash,
        authorId,
        commit.committerDate,
        Math.max(1, commit.parents.length),
        commit.subject,
      );
      const commitId = Number(commitRow.lastInsertRowid);
      const deltas = new Map<number, { added: number; removed: number }>();
      for (const file of commit.files) {
        if (file.binary) continue; // binary files are not measured (brief §2)
        if (file.oldPath) ensureObject(file.oldPath, 'file'); // keep deleted/renamed paths browsable
        if (file.added + file.removed === 0) {
          ensureObject(file.path, 'file'); // pure rename: object exists, no delta
          continue;
        }
        for (const objectId of objectChainFor(file.path)) {
          const acc = deltas.get(objectId);
          if (acc) {
            acc.added += file.added;
            acc.removed += file.removed;
          } else {
            deltas.set(objectId, { added: file.added, removed: file.removed });
          }
        }
      }
      for (const [objectId, delta] of deltas) {
        insertChange.run(repoId, commitId, objectId, delta.added, delta.removed);
      }
    }
  });

  for (let start = 0; start < commits.length; start += CHUNK) {
    insertChunk(commits.slice(start, start + CHUNK));
    const done = Math.min(start + CHUNK, commits.length);
    handle.update('history', 0.3 + 0.65 * (done / Math.max(1, commits.length)), `indexed ${done}/${commits.length} commits`);
    await yieldToLoop();
  }

  // ---- stage 4: finalise ---------------------------------------------------
  handle.update('finalise', 0.97, 'finalising');
  const head = headCommit(repoPath); // null for a repository without commits
  const count = database.prepare('SELECT COUNT(*) AS n FROM commits WHERE repository_id = ?').get(repoId) as { n: number };
  database
    .prepare(
      `UPDATE repositories SET head_commit = ?, commit_count = ?, status = 'ready', ingested_at = datetime('now')
       WHERE id = ?`,
    )
    .run(head, count.n, repoId);
}
