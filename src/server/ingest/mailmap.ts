import { spawnSync } from 'node:child_process';

export interface AuthorIdent {
  name: string;
  email: string;
}

const IDENT_RE = /^(.*?)<(.*)>\s*$/;

export function formatIdent(a: AuthorIdent): string {
  return `${a.name} <${a.email}>`;
}

export function parseIdent(line: string): AuthorIdent | null {
  const m = IDENT_RE.exec(line);
  if (!m) return null;
  return { name: m[1].trim(), email: m[2].trim() };
}

/**
 * Resolves raw author identities through the repository's .mailmap using
 * git's own `check-mailmap` (test_brief.md §1: "git provides a .mailmap to
 * merge different email addresses"). Returns a map from raw ident string to
 * canonical ident; identities absent from the mailmap map to themselves.
 */
export function resolveMailmap(repoPath: string, idents: AuthorIdent[]): Map<string, AuthorIdent> {
  const result = new Map<string, AuthorIdent>();
  if (idents.length === 0) return result;
  const input = idents.map(formatIdent).join('\n') + '\n';
  const res = spawnSync('git', ['-C', repoPath, 'check-mailmap', '--stdin'], {
    input,
    maxBuffer: 256 * 1024 * 1024,
  });
  const lines = (res.status === 0 ? res.stdout.toString('utf8') : input).split('\n');
  idents.forEach((raw, i) => {
    const canonical = parseIdent(lines[i] ?? '') ?? raw;
    result.set(formatIdent(raw), canonical);
  });
  return result;
}
