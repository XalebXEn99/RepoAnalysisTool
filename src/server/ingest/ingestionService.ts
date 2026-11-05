import fs from 'node:fs/promises';
import path from 'node:path';
import { query } from '../db/connection';
import { REPOS_DIR } from '../config';
import type { JobHandle } from '../jobs/jobManager';
import { streamGitLog, type ParsedCommit } from './gitLogParser';
import { formatIdent, resolveMailmap } from './mailmap';
import { cloneRepository, extractRepositoryZip, headCommit, locateRepoRoot } from './gitSource';

interface RepoRow {
  id: number;
  source_type: string;
  source_url: string | null;
  path: string;
}

interface MergeRow {
  source_name: string; source_email: string; target_name: string; target_email: string;
}

async function insertBatch(repoId: number, commits: ParsedCommit[]): Promise<void> {
  const authors = new Map<string, { name: string; email: string }>();
  const objects = new Map<string, { path: string; kind: 'file' | 'dir' }>();
  objects.set('', { path: '', kind: 'dir' });
  const deltas: Array<{ hash: string; path: string; added: number; removed: number }> = [];
  for (const commit of commits) {
    authors.set(`${commit.authorName}\0${commit.authorEmail}`, { name: commit.authorName, email: commit.authorEmail });
    const changes = new Map<string, { added: number; removed: number }>();
    for (const file of commit.files) {
      if (file.binary) continue;
      if (file.oldPath && !objects.has(file.oldPath)) objects.set(file.oldPath, { path: file.oldPath, kind: 'file' });
      if (!objects.has(file.path)) objects.set(file.path, { path: file.path, kind: 'file' });
      if (!file.added && !file.removed) continue;
      const parts = file.path.split('/');
      const chain = [file.path, ''];
      for (let depth = parts.length - 1; depth > 0; depth--) {
        const ancestor = parts.slice(0, depth).join('/');
        objects.set(ancestor, { path: ancestor, kind: 'dir' });
        chain.push(ancestor);
      }
      for (const objectPath of chain) {
        const change = changes.get(objectPath) ?? { added: 0, removed: 0 };
        change.added += file.added;
        change.removed += file.removed;
        changes.set(objectPath, change);
      }
    }
    for (const [objectPath, delta] of changes) deltas.push({ hash: commit.hash, path: objectPath, ...delta });
  }
  // One round trip and atomic write per batch, not one network query per file.
  await query(`WITH a AS (
    INSERT INTO authors(repository_id,name,email)
    SELECT $1,name,email FROM jsonb_to_recordset($2::jsonb) AS x(name text,email text)
    ON CONFLICT(repository_id,name,email) DO UPDATE SET name=EXCLUDED.name RETURNING id,name,email
  ), o AS (
    INSERT INTO objects(repository_id,path,kind)
    SELECT $1,path,kind FROM jsonb_to_recordset($3::jsonb) AS x(path text,kind text)
    ON CONFLICT(repository_id,path) DO UPDATE SET kind=CASE WHEN objects.kind='dir' THEN 'dir' ELSE EXCLUDED.kind END
    RETURNING id,path
  ), c AS (
    INSERT INTO commits(repository_id,hash,author_id,committer_date,parent_count,subject)
    SELECT $1,x.hash,a.id,x.date,x.parents,x.subject
    FROM jsonb_to_recordset($4::jsonb) AS x(hash text,name text,email text,date bigint,parents int,subject text,ordinal int)
    JOIN a ON a.name=x.name AND a.email=x.email ORDER BY x.ordinal
    RETURNING id,hash
  )
  INSERT INTO changes(repository_id,commit_id,object_id,added,removed)
    SELECT $1,c.id,o.id,x.added,x.removed
    FROM jsonb_to_recordset($5::jsonb) AS x(hash text,path text,added int,removed int)
    JOIN c ON c.hash=x.hash JOIN o ON o.path=x.path`,
  [repoId, JSON.stringify([...authors.values()]), JSON.stringify([...objects.values()]),
    JSON.stringify(commits.map((commit, ordinal) => ({
      hash: commit.hash, name: commit.authorName, email: commit.authorEmail, date: commit.committerDate,
      parents: Math.max(1, commit.parents.length), subject: commit.subject, ordinal,
    }))), JSON.stringify(deltas)]);
}

export async function ingestRepository(repoId: number, handle: JobHandle, signal?: AbortSignal): Promise<void> {
  const [repo] = await query<RepoRow>('SELECT * FROM repositories WHERE id=$1', [repoId]);
  if (!repo) throw new Error('repository does not exist');
  await query(`UPDATE repositories SET status='ingesting',error=NULL,head_commit=NULL,commit_count=0 WHERE id=$1`, [repoId]);
  await query(`INSERT INTO manual_author_merges(repository_id,source_name,source_email,target_name,target_email)
    SELECT $1,s.name,s.email,t.name,t.email FROM authors s JOIN authors t ON t.id=s.canonical_id
    WHERE s.repository_id=$1 AND s.merge_source='manual' AND s.id<>s.canonical_id
    ON CONFLICT(repository_id,source_name,source_email) DO UPDATE
    SET target_name=EXCLUDED.target_name,target_email=EXCLUDED.target_email`, [repoId]);
  const merges = await query<MergeRow>('SELECT * FROM manual_author_merges WHERE repository_id=$1', [repoId]);
  // Remove dependent commits first; each deletion cascades its changes.
  await query('DELETE FROM commits WHERE repository_id=$1', [repoId]);
  await query('DELETE FROM objects WHERE repository_id=$1', [repoId]);
  await query('DELETE FROM authors WHERE repository_id=$1', [repoId]);

  let repoPath = repo.path || path.join(REPOS_DIR, String(repoId));
  if (repo.source_type === 'local') {
    await handle.update('prepare', 0.05, 'using existing working copy');
  } else {
    const destination = path.join(REPOS_DIR, String(repoId));
    await fs.rm(destination, { recursive: true, force: true });
    repoPath = destination;
    if (repo.source_type === 'zip') {
      await handle.update('extract', 0.05, 'extracting uploaded zip');
      if (!repo.source_url) throw new Error('uploaded zip is missing');
      await extractRepositoryZip(repo.source_url, destination);
      const root = locateRepoRoot(destination);
      if (!root) throw new Error('zip must contain a .git directory');
      repoPath = root;
      const gitPath = path.join(root, '.git');
      if (!(await fs.lstat(gitPath)).isDirectory()) throw new Error('archive .git must be a self-contained directory, not an external gitfile');
      const configPath = path.join(gitPath, 'config');
      const originalConfig = await fs.readFile(configPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return '';
        throw error;
      });
      // Do not execute repository-supplied config includes, filters, hooks or helpers.
      const sha256 = /^\s*objectformat\s*=\s*sha256\s*$/im.test(originalConfig);
      await fs.writeFile(configPath, `[core]\nrepositoryformatversion=${sha256 ? 1 : 0}\nbare=false\n${sha256 ? '[extensions]\nobjectformat=sha256\n' : ''}`);
      if (await fs.stat(path.join(gitPath, 'objects', 'info', 'alternates')).then(() => true, (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return false;
        throw error;
      })) throw new Error('archive Git object alternates are not supported');
    } else {
      await handle.update('clone', 0.05, 'cloning full repository history');
      if (!repo.source_url) throw new Error('repository URL is missing');
      await cloneRepository(repo.source_url, destination, signal);
    }
  }
  if (!locateRepoRoot(repoPath)) throw new Error('repository has no .git directory');
  const head = headCommit(repoPath);
  await query('UPDATE repositories SET path=$1 WHERE id=$2', [repoPath, repoId]);
  await handle.update('history', 0.2, 'streaming history');
  let batch: ParsedCommit[] = [];
  let files = 0;
  let count = 0;
  for await (const commit of streamGitLog(repoPath, signal)) {
    signal?.throwIfAborted();
    batch.push(commit);
    files += commit.files.length;
    if (batch.length >= 250 || files >= 10000) {
      await insertBatch(repoId, batch);
      count += batch.length;
      batch = [];
      files = 0;
      await handle.update('history', 0.5, `indexed ${count} commits`);
    }
  }
  if (batch.length) { await insertBatch(repoId, batch); count += batch.length; }
  await query(`INSERT INTO objects(repository_id,path,kind) VALUES ($1,'','dir') ON CONFLICT DO NOTHING`, [repoId]);
  await handle.update('authors', 0.85, 'resolving author identities');
  const authors = await query<{ id: number; name: string; email: string }>('SELECT id,name,email FROM authors WHERE repository_id=$1 ORDER BY id', [repoId]);
  const resolved = resolveMailmap(repoPath, authors);
  const canonical = [...new Map([...resolved.values()].map((ident) => [formatIdent(ident), ident])).values()];
  if (canonical.length) {
    await query(`INSERT INTO authors(repository_id,name,email)
      SELECT $1,name,email FROM jsonb_to_recordset($2::jsonb) AS x(name text,email text)
      ON CONFLICT DO NOTHING`, [repoId, JSON.stringify(canonical)]);
    const mapping = authors.map((author) => {
      const target = resolved.get(formatIdent(author)) ?? author;
      return { id: author.id, name: target.name, email: target.email, source: formatIdent(author) === formatIdent(target) ? 'identity' : 'mailmap' };
    });
    await query(`UPDATE authors a SET canonical_id=t.id,merge_source=x.source
      FROM jsonb_to_recordset($2::jsonb) AS x(id int,name text,email text,source text),authors t
      WHERE a.id=x.id AND t.repository_id=$1 AND t.name=x.name AND t.email=x.email`, [repoId, JSON.stringify(mapping)]);
  }
  await query(`UPDATE authors SET canonical_id=id,merge_source='mailmap' WHERE repository_id=$1 AND canonical_id IS NULL`, [repoId]);
  for (const merge of merges) {
    await query(`UPDATE authors SET canonical_id=t.canonical_id,merge_source='manual'
      FROM authors s,authors t WHERE authors.repository_id=$1 AND s.repository_id=$1 AND t.repository_id=$1
      AND s.name=$2 AND s.email=$3 AND t.name=$4 AND t.email=$5
      AND (authors.id=s.id OR authors.canonical_id=s.id)`,
    [repoId, merge.source_name, merge.source_email, merge.target_name, merge.target_email]);
  }
  await handle.update('finalise', 0.97, 'finalising');
  await query(`UPDATE repositories SET head_commit=$1,commit_count=$2,status='ready',ingested_at=now() WHERE id=$3`, [head, count, repoId]);
}
