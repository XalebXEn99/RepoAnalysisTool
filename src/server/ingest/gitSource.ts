import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import extractZip from 'extract-zip';
import type { AuthorIdent } from './mailmap';

export function runGit(repoPath: string, args: string[]): string {
  const res = spawnSync('git', ['-C', repoPath, ...args], {
    maxBuffer: 512 * 1024 * 1024,
    env: { ...process.env, GIT_PAGER: 'cat', LC_ALL: 'C' },
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${res.stderr?.toString().trim() || 'unknown error'}`);
  }
  return res.stdout.toString('utf8');
}

/** Deep clone (full history) of a remote repository, per docs/test_brief.md §1. */
export function cloneRepository(url: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const res = spawnSync('git', ['clone', '--', url, dest], {
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`git clone failed: ${res.stderr?.toString().trim() || 'unknown error'}`);
  }
}

export async function extractRepositoryZip(zipPath: string, dest: string): Promise<void> {
  fs.mkdirSync(dest, { recursive: true });
  await extractZip(zipPath, { dir: dest });
}

/** A repository zip must ship its .git (docs/test_brief.md §1). */
export function hasGitDir(dir: string): boolean {
  return fs.existsSync(path.join(dir, '.git'));
}

/**
 * Zips often wrap the repo in a single top-level folder; locate the actual
 * repository root at depth <= 1 below the extraction directory.
 */
export function locateRepoRoot(extractDir: string): string | null {
  if (hasGitDir(extractDir)) return extractDir;
  for (const entry of fs.readdirSync(extractDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(extractDir, entry.name);
    if (hasGitDir(candidate)) return candidate;
  }
  return null;
}

/**
 * HEAD of the working copy, or null when the repository has no commits yet
 * (an unborn HEAD is a valid, empty repository rather than an error).
 */
export function headCommit(repoPath: string): string | null {
  const res = spawnSync('git', ['-C', repoPath, 'rev-parse', '--verify', '-q', 'HEAD'], {
    env: { ...process.env, GIT_PAGER: 'cat', LC_ALL: 'C' },
  });
  if (res.error) throw res.error;
  if (res.status !== 0) return null;
  return res.stdout.toString('utf8').trim() || null;
}

export function commitSubject(repoPath: string, hash: string): string {
  return runGit(repoPath, ['log', '-1', '--pretty=%s', hash]).trim();
}

/** Distinct raw author identities over H-bar (non-merge commits). */
export function listAuthorIdents(repoPath: string): AuthorIdent[] {
  if (headCommit(repoPath) === null) return []; // no history to attribute
  const out = runGit(repoPath, ['log', '--no-merges', '--pretty=format:%an%x00%ae%x01']);
  const seen = new Set<string>();
  const idents: AuthorIdent[] = [];
  for (const record of out.split('\x01')) {
    const trimmed = record.replace(/^\n+/, '').trim();
    if (!trimmed) continue;
    const [name, email] = trimmed.split('\0');
    if (name === undefined || email === undefined) continue;
    const key = `${name}\u0000${email}`;
    if (seen.has(key)) continue;
    seen.add(key);
    idents.push({ name, email });
  }
  return idents;
}

export function repoNameFromUrl(url: string): string {
  const cleaned = url.trim().replace(/\/+$/, '');
  const last = cleaned.split(/[/:]/).pop() ?? cleaned;
  return last.replace(/\.git$/, '') || 'repository';
}

export function repoNameFromZip(fileName: string): string {
  return path.basename(fileName).replace(/\.zip$/i, '') || 'repository';
}
