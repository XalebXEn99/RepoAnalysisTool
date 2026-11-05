import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from '../config';

const wakePath = path.join(DATA_DIR, 'worker-wake');

export async function wakeWorker(): Promise<void> {
  await fs.writeFile(wakePath, `${Date.now()}:${Math.random()}`);
}

export async function wakeVersion(): Promise<string> {
  try {
    return await fs.readFile(wakePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}
