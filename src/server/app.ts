import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { CLIENT_DIST } from './config';
import { db } from './db/connection';
import { reposRouter } from './routes/repos';
import { authorsRouter } from './routes/authors';
import { metricsRouter } from './routes/metrics';
import { browseRouter } from './routes/commits';

/**
 * Builds the Express application without binding a port, so tests can mount it
 * on an ephemeral one (tests/unit/api.test.ts). index.ts adds the listener.
 */
export function createApp(): Express {
  const app = express();
  const jsonParser = express.json({ limit: '2mb' });

  // JSON bodies everywhere except the raw zip stream route.
  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' && req.path === '/repos/upload') return next();
    return jsonParser(req, res, next);
  });

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      repositories: (db().prepare('SELECT COUNT(*) n FROM repositories').get() as { n: number }).n,
    });
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
  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    res.status(500).json({ error: err?.message ?? 'internal error' });
  });

  return app;
}
