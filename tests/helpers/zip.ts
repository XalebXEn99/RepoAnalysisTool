import fs from 'node:fs';
import path from 'node:path';
import { zipSync } from 'fflate';

/** Includes hidden .git files, with fixed timestamps for deterministic archives. */
export function buildZip(source: string, destination: string, prefix = ''): void {
  const entries: Record<string, Uint8Array> = {};
  function walk(dir: string, relative: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, name);
      else entries[name] = fs.readFileSync(full);
    }
  }
  walk(source, prefix);
  fs.writeFileSync(destination, zipSync(entries, { level: 0, mtime: new Date('2020-01-01T00:00:00Z') }));
}
