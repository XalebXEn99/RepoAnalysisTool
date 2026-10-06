import express, { type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { CLIENT_DIST, PORT, ensureDataDirs } from './config';
import { db } from './db/connection';
import { reposRouter } from './routes/repos';
import { authorsRouter } from './routes/authors';
import { metricsRouter } from './routes/metrics';
import { browseRouter } from './routes/commits';

const app = express();
const jsonParser = express.json({ limit: '2mb' });

// JSON bodies everywhere except the raw zip stream route.
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.path === '/repos/upload') return next();
  return jsonParser(req, res, next);
});

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ ok: true, repositories: (db().prepare('SELECT COUNT(*) n FROM repositories').get() as { n: number }).n });
});

app.use('/api/repos', reposRouter);
app.use('/api/repos', browseRouter);
app.use('/api/repos', authorsRouter);
app.use('/api/metrics', metricsRouter);

app.use('/api', (_req: Request, res: Response) => res.status(404).json({ error: 'unknown api route' }));

// Serve the built client when present (production mode); dev uses Vite.
if (fs.existsSync(path.join(CLIENT_DIST, 'index.html'))) {
  app.use(express.static(CLIENT_DIST));
  app.get('*', (_req: Request, res: Response) => res.sendFile(path.join(CLIENT_DIST, 'index.html')));
} else {
  app.get('/', (_req: Request, res: Response) =>
    res.send('RAT server is running. Start the web client with `npm run dev:web` (http://localhost:5173).'),
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
app.use((err: any, _req: Request, res: Response, next: express.NextFunction) => {
  if (res.headersSent) return next(err);
  res.status(500).json({ error: err?.message ?? 'internal error' });
});

ensureDataDirs();
db();

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[rat] api listening on http://127.0.0.1:${PORT}`);
});
