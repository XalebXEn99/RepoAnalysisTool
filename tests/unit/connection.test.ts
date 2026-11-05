import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const drivers = vi.hoisted(() => ({
  tcp: vi.fn(),
  neon: vi.fn(),
  session: vi.fn(),
  release: vi.fn(),
  end: vi.fn(),
  config: { poolQueryViaFetch: false },
}));

vi.mock('pg', () => ({
  types: { setTypeParser: vi.fn() },
  Pool: class {
    constructor() { drivers.tcp(); }
    on() {}
    query = async () => ({ rows: [{ connected: 1 }] });
    connect = async () => {
      drivers.session();
      return { query: this.query, release: drivers.release };
    };
    end = drivers.end;
  },
}));

vi.mock('@neondatabase/serverless', () => ({
  types: { setTypeParser: vi.fn() },
  neonConfig: drivers.config,
  Pool: class {
    constructor() { drivers.neon(); }
    on() {}
    query = async () => ({ rows: [{ connected: 1 }] });
    end = drivers.end;
  },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv('DATABASE_URL', 'postgresql://test:test@database.invalid/test');
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('explicit database transports', () => {
  it('uses PostgreSQL sessions for TCP queries', async () => {
    vi.stubEnv('RAT_DATABASE_TRANSPORT', 'tcp');
    const db = await import('../../src/server/db/connection');
    expect(await db.query('SELECT 1')).toEqual([{ connected: 1 }]);
    expect(drivers.tcp).toHaveBeenCalledOnce();
    expect(drivers.neon).not.toHaveBeenCalled();
    expect(drivers.config.poolQueryViaFetch).toBe(false);
    await db.closeDb();
  });

  it('uses HTTP queries but a distinct TCP session for migrations', async () => {
    vi.stubEnv('RAT_DATABASE_TRANSPORT', 'http');
    const db = await import('../../src/server/db/connection');
    expect(await db.query('SELECT 1')).toEqual([{ connected: 1 }]);
    expect(drivers.config.poolQueryViaFetch).toBe(true);
    expect(drivers.neon).toHaveBeenCalledOnce();
    expect(drivers.tcp).not.toHaveBeenCalled();
    const client = await db.connectDatabase();
    expect(drivers.tcp).toHaveBeenCalledOnce();
    expect(drivers.session).toHaveBeenCalledOnce();
    client.release();
    await db.closeDb();
    expect(drivers.end).toHaveBeenCalledTimes(2);
  });

  it('keeps WebSocket explicitly selected without HTTP fallback', async () => {
    vi.stubEnv('RAT_DATABASE_TRANSPORT', 'websocket');
    const db = await import('../../src/server/db/connection');
    await db.query('SELECT 1');
    expect(drivers.neon).toHaveBeenCalledOnce();
    expect(drivers.config.poolQueryViaFetch).toBe(false);
    await db.closeDb();
  });

  it('rejects invalid transport settings instead of silently choosing a driver', async () => {
    vi.stubEnv('RAT_DATABASE_TRANSPORT', 'invalid');
    const db = await import('../../src/server/db/connection');
    await expect(db.query('SELECT 1')).rejects.toThrow('RAT_DATABASE_TRANSPORT must be');
  });
});
