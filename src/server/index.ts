import { HOST, PORT, ensureDataDirs } from './config';
import { createApp } from './app';
import { db } from './db/connection';

// Data directories and the SQLite connection must exist before the first request.
ensureDataDirs();
db();

createApp().listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`[rat] api listening on http://${HOST}:${PORT}`);
});
