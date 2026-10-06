import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Deterministic git fixture covering every edge case the brief calls out:
 * renames (pure and with edits), deletions, binary files, merge commits,
 * paths with spaces, multiple author identities and a .mailmap.
 */

export const FIXTURE_ROOT = path.resolve(__dirname, '../../data/test-tmp');
export const BASE_DATE = 1600000000;
export const DAY = 86400;

const ONE = { name: 'Probe One', email: 'one@x.dev' };
const UNO = { name: 'Probe Uno', email: 'uno@x.dev' };

let counter = 0;
const created: string[] = [];

export function scratchDir(name: string): string {
  counter += 1;
  const dir = path.join(FIXTURE_ROOT, `${name}-${process.pid}-${counter}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  created.push(dir);
  return dir;
}

/**
 * Removes every scratch directory this process created. Call it from a suite's
 * afterAll so repeated runs do not accumulate fixture repositories; the shared
 * root is only dropped when empty, because forks run suites in parallel.
 */
export function cleanupScratch(): void {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  try {
    fs.rmdirSync(FIXTURE_ROOT);
  } catch {
    // not empty: another worker is still running
  }
}

function git(dir: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync('git', ['-C', dir, ...args], {
    env: { ...process.env, GIT_PAGER: 'cat', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
}

function commit(
  dir: string,
  message: string,
  dayOffset: number,
  author: { name: string; email: string } = ONE,
): string {
  const date = String(BASE_DATE + dayOffset * DAY);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', message, '--allow-empty'], {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
    GIT_COMMITTER_DATE: date,
  });
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

/** Real two-parent merge, so c8 lands in the commits table as a merge and is excluded from H-bar. */
function merge(dir: string, message: string, dayOffset: number, branch: string): string {
  const date = String(BASE_DATE + dayOffset * DAY);
  git(dir, ['merge', '-q', '--no-ff', '--no-edit', '-m', message, branch], {
    GIT_AUTHOR_NAME: ONE.name,
    GIT_AUTHOR_EMAIL: ONE.email,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: ONE.name,
    GIT_COMMITTER_EMAIL: ONE.email,
    GIT_COMMITTER_DATE: date,
  });
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

export interface Fixture {
  dir: string;
  hashes: Record<string, string>;
  dateOf: (dayOffset: number) => number;
}

export function createFixtureRepo(): Fixture {
  const dir = scratchDir('fixture');
  git(dir, ['init', '-q', '-b', 'main', '.']);
  git(dir, ['config', 'user.name', ONE.name]);
  git(dir, ['config', 'user.email', ONE.email]);

  const hashes: Record<string, string> = {};

  fs.mkdirSync(path.join(dir, 'dir/sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'l1\nl2\nl3\n');
  fs.writeFileSync(path.join(dir, 'dir/sub/b.txt'), 'b1\nb2\n');
  hashes.c1 = commit(dir, 'c1 initial', 0);

  fs.writeFileSync(path.join(dir, 'a.txt'), 'l1\nl2x\nl3\nl4\nl5\n');
  git(dir, ['mv', 'dir/sub/b.txt', 'dir/c.txt']);
  hashes.c2 = commit(dir, 'c2 modify and pure rename', 1);

  fs.writeFileSync(path.join(dir, 'dir/d.txt'), 'b1\nb2\nb3\n');
  fs.rmSync(path.join(dir, 'dir/c.txt'));
  hashes.c3 = commit(dir, 'c3 rename with change', 2);

  fs.rmSync(path.join(dir, 'dir/d.txt'));
  hashes.c4 = commit(dir, 'c4 delete', 3);

  fs.writeFileSync(path.join(dir, 'bin.dat'), 'textual\n');
  hashes.c5 = commit(dir, 'c5 textual file', 4);

  fs.writeFileSync(path.join(dir, 'my file.txt'), 'spaced\n');
  hashes.c6 = commit(dir, 'c6 spaced path', 5);

  git(dir, ['checkout', '-qb', 'side']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'l1\nl2x\nl3\nl4\nl5\nside\n');
  hashes.c7 = commit(dir, 'c7 side branch by uno', 6, UNO);
  git(dir, ['checkout', '-q', 'main']);
  hashes.c8 = merge(dir, 'c8 merge side', 7, 'side');

  fs.writeFileSync(path.join(dir, 'real.bin'), Buffer.from([0x00, 0x01, 0x00, 0xff]));
  hashes.c9 = commit(dir, 'c9 binary', 8);

  fs.writeFileSync(path.join(dir, '.mailmap'), `Probe One <one@x.dev> Probe Uno <uno@x.dev>\n`);
  hashes.c10 = commit(dir, 'c10 mailmap', 9);

  return { dir, hashes, dateOf: (dayOffset: number) => BASE_DATE + dayOffset * DAY };
}

/** Hand-computed expectations for the fixture (see tests for derivations). */
export const EXPECTED = {
  nonMergeCommits: 9,
  root: { added: 13, removed: 4, growth: 9, churn: 17, modifications: 8 },
  fileA: { added: 7, removed: 1, growth: 6, churn: 8, modifications: 3 },
  dirDir: { added: 3, removed: 3, growth: 0, churn: 6, modifications: 3 },
  dirSub: { added: 2, removed: 0, growth: 2, churn: 2, modifications: 1 },
};
