import { HOST, PORT, ensureDataDirs } from './config';
import { createApp } from './app';
import { query, closeDb } from './db/connection';

// Verify storage and PostgreSQL connectivity before accepting requests.
ensureDataDirs();
await query('SELECT 1');
const server = createApp().listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`[rat] api listening on http://${HOST}:${PORT}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close(() => { void closeDb().catch((error: unknown) => { console.error(error); process.exitCode = 1; }); });
  });
}
