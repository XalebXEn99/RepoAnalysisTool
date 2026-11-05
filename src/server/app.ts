import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { APP_ORIGIN, CLIENT_DIST } from './config';
import { query } from './db/connection';
import { reposRouter } from './routes/repos';
import { authorsRouter } from './routes/authors';
import { metricsRouter } from './routes/metrics';
import { browseRouter } from './routes/commits';
import { asyncRoute, HttpError } from './http';

export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });
  app.use('/api', (req, _res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)
      && ((req.headers.origin && req.headers.origin !== APP_ORIGIN)
        || req.headers['sec-fetch-site'] === 'cross-site')) {
      return next(new HttpError(403, 'untrusted request origin'));
    }
    next();
  });
  const jsonParser = express.json({ limit: '128kb' });
  app.use('/api', (req, res, next) => req.method === 'POST' && req.path === '/repos/upload' ? next() : jsonParser(req, res, next));
  app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.get('/api/health', asyncRoute(async (_req, res) => {
    const [{ n }] = await query<{ n: number }>('SELECT COUNT(*) AS n FROM repositories');
    res.json({ ok: true, repositories: n });
  }));
  app.use('/api/repos', reposRouter, browseRouter, authorsRouter);
  app.use('/api/metrics', metricsRouter);
  app.use('/api', (_req, res) => { res.status(404).json({ error: 'unknown api route' }); });
  if (fs.existsSync(path.join(CLIENT_DIST, 'index.html'))) {
    app.use('/assets', express.static(path.join(CLIENT_DIST, 'assets'), { maxAge: '1y', immutable: true }));
    app.use(express.static(CLIENT_DIST, { maxAge: 0 }));
    app.get('*', (_req, res) => res.sendFile(path.join(CLIENT_DIST, 'index.html')));
  } else {
    app.get('/', (_req, res) => res.send('RAT API is running. Start the Vite client for development.'));
  }
  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(error);
    const status = error instanceof HttpError ? error.status : 500;
    console.error(`[api] ${status}`, error instanceof Error ? error.message : String(error));
    res.status(status).json({ error: status === 500 ? 'internal server error' : (error as HttpError).message });
  });
  return app;
}
