import { afterAll, describe, expect, it } from 'vitest';
import { parseGitLog, runGitLog } from '../../src/server/ingest/gitLogParser';
import { cleanupScratch, createFixtureRepo, EXPECTED, type Fixture } from '../helpers/fixture';

describe('git log parser', () => {
  const fixture: Fixture = createFixtureRepo();
  const commits = parseGitLog(runGitLog(fixture.dir));
  afterAll(cleanupScratch);
  // Match on a word boundary: 'c1' must not prefix-match 'c10 mailmap'.
  const bySubject = (prefix: string) =>
    commits.find((c) => c.subject === prefix || c.subject.startsWith(`${prefix} `));

  it('excludes merge commits from H-bar', () => {
    expect(commits).toHaveLength(EXPECTED.nonMergeCommits);
    expect(bySubject('c8')).toBeUndefined();
  });

  it('records committer dates', () => {
    expect(bySubject('c1')?.committerDate).toBe(fixture.dateOf(0));
    expect(bySubject('c10')?.committerDate).toBe(fixture.dateOf(9));
  });

  it('attributes pure renames to the new path with zero deltas', () => {
    const rename = bySubject('c2')?.files.find((f) => f.oldPath === 'dir/sub/b.txt');
    expect(rename).toMatchObject({ path: 'dir/c.txt', added: 0, removed: 0 });
  });

  it('attributes rename-with-edit deltas to the new path', () => {
    const rename = bySubject('c3')?.files.find((f) => f.oldPath === 'dir/c.txt');
    expect(rename).toMatchObject({ path: 'dir/d.txt', added: 1, removed: 0 });
  });

  it('records deletions as removed lines on the old path', () => {
    expect(bySubject('c4')?.files).toEqual([
      expect.objectContaining({ path: 'dir/d.txt', added: 0, removed: 3 }),
    ]);
  });

  it('flags binary files using git detection', () => {
    const binary = bySubject('c9')?.files.find((f) => f.path === 'real.bin');
    expect(binary?.binary).toBe(true);
    const textual = bySubject('c5')?.files.find((f) => f.path === 'bin.dat');
    expect(textual?.binary).toBe(false);
  });

  it('handles paths containing spaces unquoted', () => {
    expect(bySubject('c6')?.files).toEqual([
      expect.objectContaining({ path: 'my file.txt', added: 1, removed: 0 }),
    ]);
  });

  it('keeps author identities per commit', () => {
    expect(bySubject('c7')).toMatchObject({ authorName: 'Probe Uno', authorEmail: 'uno@x.dev' });
    expect(bySubject('c6')).toMatchObject({ authorName: 'Probe One', authorEmail: 'one@x.dev' });
  });
});
