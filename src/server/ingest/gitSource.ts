import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import yauzl, { type Entry, type ZipFile } from 'yauzl';
import { pipeline } from 'node:stream/promises';
import type { AuthorIdent } from './mailmap';
import { GIT_TIMEOUT_MS, MAX_EXTRACT_BYTES } from '../config';
import { HttpError } from '../http';

export function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env, GIT_PAGER: 'cat', LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_ALLOW_PROTOCOL: 'https',
  };
}

export function validateRemoteUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new HttpError(400, 'a valid HTTPS repository URL is required'); }
  const allowed = (process.env.RAT_ALLOWED_GIT_HOSTS ?? 'github.com,gitlab.com,bitbucket.org').split(',').map((host) => host.trim().toLowerCase());
  if (url.protocol !== 'https:' || !allowed.includes(url.hostname.toLowerCase()) ||
    url.username || url.password || url.port || url.search || url.hash) {
    throw new HttpError(400, 'use a public HTTPS repository URL on an allowed Git host; embedded credentials are not accepted');
  }
  return url.toString();
}

export function runGit(repoPath: string, args: string[]): string {
  const res = spawnSync('git', ['-C', repoPath, ...args], {
    maxBuffer: 512 * 1024 * 1024,
    timeout: GIT_TIMEOUT_MS,
    env: gitEnvironment(),
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${res.stderr?.toString().trim() || 'unknown error'}`);
  }
  return res.stdout.toString('utf8');
}

/** Deep clone (full history) of a remote repository, per docs/test_brief.md §1. */
export async function cloneRepository(url: string, dest: string, signal?: AbortSignal): Promise<void> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', ['-c', 'http.followRedirects=false', 'clone', '--no-checkout', '--', validateRemoteUrl(url), dest], {
      env: gitEnvironment(), stdio: ['ignore', 'ignore', 'pipe'], signal, timeout: GIT_TIMEOUT_MS,
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000); });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`git clone failed: ${stderr || `exit ${code}`}`)));
  });
}

export async function extractRepositoryZip(zipPath: string, dest: string): Promise<void> {
  await fs.promises.mkdir(dest, { recursive: true });
  let bytes = 0;
  let entries = 0;
  const zip = await new Promise<ZipFile>((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, validateEntrySizes: true }, (error, file) => {
      if (error || !file) reject(error ?? new Error('unable to open archive'));
      else resolve(file);
    });
  });
  await new Promise<void>((resolve, reject) => {
    const fail = (error: unknown) => { zip.close(); reject(error); };
    zip.once('error', fail);
    zip.once('end', resolve);
    zip.on('entry', (entry: Entry) => {
      void (async () => {
        bytes += entry.uncompressedSize;
        entries += 1;
        if (((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000) throw new Error('archive symlinks are not supported');
        if (bytes > MAX_EXTRACT_BYTES || entries > 100000) throw new Error('archive exceeds extracted size or file-count limit');
        if (entry.fileName.includes('\\') || entry.fileName.includes('\0')) throw new Error('invalid archive path');
        const output = path.resolve(dest, entry.fileName);
        const relative = path.relative(dest, output);
        if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('archive path escapes destination');
        if (entry.fileName.endsWith('/')) {
          await fs.promises.mkdir(output, { recursive: true });
        } else {
          await fs.promises.mkdir(path.dirname(output), { recursive: true });
          const stream = await new Promise<NodeJS.ReadableStream>((openResolve, openReject) => {
            zip.openReadStream(entry, (error, readable) => error || !readable ? openReject(error ?? new Error('invalid archive entry')) : openResolve(readable));
          });
          await pipeline(stream, fs.createWriteStream(output, { flags: 'wx' }));
        }
        zip.readEntry();
      })().catch(fail);
    });
    zip.readEntry();
  });
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
    env: gitEnvironment(),
    timeout: GIT_TIMEOUT_MS,
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
