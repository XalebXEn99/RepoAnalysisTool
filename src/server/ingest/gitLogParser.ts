import { spawnSync } from 'node:child_process';
import { RENAME_THRESHOLD } from '../config';

/**
 * Streaming-safe parser for `git log --numstat -z`.
 *
 * Byte protocol (verified empirically against git 2.43, see data/probe):
 *   - each commit record starts with the sentinel byte 0x01 (from --pretty)
 *   - header fields are NUL separated: hash, author name, author email,
 *     committer date, parents (space separated), subject; terminated by \n
 *   - each numstat entry is `added \t removed \t` followed by
 *       * `path \0`                        for add/modify/delete
 *       * `\0 oldPath \0 newPath \0`       for rename/copy detection
 *     entries are NUL terminated (no newlines with -z)
 *   - a commit block ends with one extra NUL before the next sentinel
 *   - binary files report `-` for both counters (git's own binary detection)
 */

export interface ParsedFileChange {
  /** Path the change is attributed to (the NEW path for renames). */
  path: string;
  /** Previous path when git detected a rename/copy, else null. */
  oldPath: string | null;
  added: number;
  removed: number;
  /** True when git reports `-  -` (binary): excluded from all metrics. */
  binary: boolean;
}

export interface ParsedCommit {
  hash: string;
  authorName: string;
  authorEmail: string;
  /** h[committer-date] as unix seconds. */
  committerDate: number;
  parents: string[];
  subject: string;
  files: ParsedFileChange[];
}

const SENTINEL = 0x01;
const NUL = 0x00;
const TAB = 0x09;
const NL = 0x0a;

export const GIT_LOG_PRETTY = `format:${String.fromCharCode(SENTINEL)}%H%x00%an%x00%ae%x00%ct%x00%P%x00%s`;

export function gitLogArgs(): string[] {
  return [
    'log',
    '--no-merges', // H-bar excludes merge commits (test_brief.md §2)
    '--numstat',
    `-M${RENAME_THRESHOLD}`, // rename detection at 50%
    '-z', // unquoted, NUL separated paths: the only unambiguous format
    `--pretty=${GIT_LOG_PRETTY}`,
  ];
}

/** Runs git log for the whole reachable history of HEAD and returns stdout. */
export function runGitLog(repoPath: string): Buffer {
  const res = spawnSync('git', ['-C', repoPath, ...gitLogArgs()], {
    maxBuffer: 2 * 1024 * 1024 * 1024,
    env: { ...process.env, GIT_PAGER: 'cat', LC_ALL: 'C' },
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`git log failed: ${res.stderr?.toString() ?? 'unknown error'}`);
  }
  return res.stdout;
}

class Cursor {
  constructor(private readonly buf: Buffer, public pos = 0) {}
  eof(): boolean {
    return this.pos >= this.buf.length;
  }
  peek(): number {
    return this.buf[this.pos];
  }
  /** Reads up to and consuming the given byte. */
  readUntil(byte: number): string {
    const start = this.pos;
    const idx = this.buf.indexOf(byte, start);
    if (idx === -1) {
      this.pos = this.buf.length;
      return this.buf.toString('utf8', start, this.buf.length);
    }
    this.pos = idx + 1;
    return this.buf.toString('utf8', start, idx);
  }
}

export function parseGitLog(buf: Buffer): ParsedCommit[] {
  const commits: ParsedCommit[] = [];
  const cur = new Cursor(buf);

  while (!cur.eof()) {
    if (cur.peek() !== SENTINEL) {
      // Skip any stray bytes between records (defensive).
      cur.pos += 1;
      continue;
    }
    cur.pos += 1; // consume sentinel

    const header = cur.readUntil(NL);
    const fields = header.split('\0');
    if (fields.length < 6) continue; // malformed record, ignore
    const [hash, authorName, authorEmail, dateStr, parentStr, subject] = fields;

    const commit: ParsedCommit = {
      hash,
      authorName,
      authorEmail,
      committerDate: Number.parseInt(dateStr, 10) || 0,
      parents: parentStr.length > 0 ? parentStr.split(' ') : [],
      subject,
      files: [],
    };

    // numstat entries until the block-terminating NUL / next sentinel.
    while (!cur.eof()) {
      const b = cur.peek();
      if (b === SENTINEL) break; // next record begins
      if (b === NUL) {
        cur.pos += 1; // end-of-block terminator
        continue;
      }
      const addedRaw = cur.readUntil(TAB);
      const removedRaw = cur.readUntil(TAB);
      let path: string;
      let oldPath: string | null = null;
      if (!cur.eof() && cur.peek() === NUL) {
        cur.pos += 1; // rename marker
        oldPath = cur.readUntil(NUL);
        path = cur.readUntil(NUL);
      } else {
        path = cur.readUntil(NUL);
      }
      const binary = addedRaw === '-' || removedRaw === '-';
      commit.files.push({
        path,
        oldPath,
        added: binary ? 0 : Number.parseInt(addedRaw, 10) || 0,
        removed: binary ? 0 : Number.parseInt(removedRaw, 10) || 0,
        binary,
      });
    }
    commits.push(commit);
  }
  return commits;
}
