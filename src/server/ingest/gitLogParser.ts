import { spawnSync } from 'node:child_process';
import { RENAME_THRESHOLD } from '../config';
import { headCommit } from './gitSource';

/**
 * Streaming-safe parser for `git log --numstat -z`.
 *
 * Byte protocol (verified empirically against git 2.43, see data/probe2.mts):
 *   - each commit record starts with the sentinel byte 0x01 (from --pretty)
 *   - header fields are NUL separated: hash, author name, author email,
 *     committer date, parents (space separated), subject
 *   - the subject is the last header field and its terminator depends on
 *     whether the commit changed any files:
 *       * `\n`  when numstat output follows
 *       * NUL  when it does not (git emits no newline after a file-less
 *              header, only the record separator)
 *     Reading to `\n` unconditionally therefore swallows every record that
 *     follows a file-less commit, so the terminator has to be observed.
 *   - each numstat entry is `added \t removed \t` followed by
 *       * `path \0`                        for add/modify/delete
 *       * `\0 oldPath \0 newPath \0`       for rename/copy detection
 *     entries are NUL terminated (no newlines with -z)
 *   - a commit block ends with one extra NUL before the next sentinel, absent
 *     at the very end of the stream
 *   - binary files report `-` for both counters (git's own binary detection)
 *   - a repository with an unborn HEAD produces no output at all
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

/** SHA-1 (40) or SHA-256 (64) object names; used to detect a mis-framed record. */
const HASH_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Runs git log for the whole reachable history of HEAD and returns stdout. */
export function runGitLog(repoPath: string): Buffer {
  const res = spawnSync('git', ['-C', repoPath, ...gitLogArgs()], {
    maxBuffer: 2 * 1024 * 1024 * 1024,
    env: { ...process.env, GIT_PAGER: 'cat', LC_ALL: 'C' },
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    // A repository whose HEAD is unborn has no history: empty log, not an error.
    if (headCommit(repoPath) === null) return Buffer.alloc(0);
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
  /** Reads up to the nearest of `bytes`; terminator is -1 when the stream ends first. */
  readUntilAny(bytes: number[]): { text: string; terminator: number } {
    const start = this.pos;
    let nearest = -1;
    for (const byte of bytes) {
      const idx = this.buf.indexOf(byte, start);
      if (idx !== -1 && (nearest === -1 || idx < nearest)) nearest = idx;
    }
    if (nearest === -1) {
      this.pos = this.buf.length;
      return { text: this.buf.toString('utf8', start, this.buf.length), terminator: -1 };
    }
    const terminator = this.buf[nearest];
    this.pos = nearest + 1;
    return { text: this.buf.toString('utf8', start, nearest), terminator };
  }
  /** Index of the next sentinel at or after the cursor, or -1. */
  nextSentinel(): number {
    return this.buf.indexOf(SENTINEL, this.pos);
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

    const hash = cur.readUntil(NUL);
    if (!HASH_RE.test(hash)) {
      // Not a record header: resync on the next sentinel rather than guess.
      const next = cur.nextSentinel();
      if (next === -1) break;
      cur.pos = next;
      continue;
    }
    const authorName = cur.readUntil(NUL);
    const authorEmail = cur.readUntil(NUL);
    const dateStr = cur.readUntil(NUL);
    const parentStr = cur.readUntil(NUL);
    const { text: subject, terminator } = cur.readUntilAny([NL, NUL]);

    const commit: ParsedCommit = {
      hash,
      authorName,
      authorEmail,
      committerDate: Number.parseInt(dateStr, 10) || 0,
      parents: parentStr.length > 0 ? parentStr.split(' ') : [],
      subject,
      files: [],
    };

    // numstat entries follow only when the header ended with a newline; a
    // file-less commit goes straight to the record separator.
    if (terminator === NL) {
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
    }
    commits.push(commit);
  }
  return commits;
}
