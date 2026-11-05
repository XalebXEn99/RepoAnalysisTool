import '../env';
import { Pool, types, type PoolConfig, type QueryResultRow } from 'pg';
import { Pool as NeonPool, neonConfig, types as neonTypes } from '@neondatabase/serverless';
import WebSocket from 'ws';

// PostgreSQL returns bigint aggregates as strings. Reject unsafe precision loss.
function parseInteger(value: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error('metric exceeds JavaScript safe integer range');
  return result;
}
types.setTypeParser(20, parseInteger);
neonTypes.setTypeParser(20, parseInteger);

neonConfig.webSocketConstructor = WebSocket;
let pool: Pool | NeonPool | undefined;
let sessionPool: Pool | undefined;

function poolOptions(): PoolConfig {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  return {
    connectionString: process.env.DATABASE_URL,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000,
    statement_timeout: 60000,
  };
}

export function databasePool(): Pool | NeonPool {
  if (!pool) {
    const transport = process.env.RAT_DATABASE_TRANSPORT ?? 'tcp';
    if (!['tcp', 'websocket', 'http'].includes(transport)) {
      throw new Error('RAT_DATABASE_TRANSPORT must be tcp, websocket, or http');
    }
    neonConfig.poolQueryViaFetch = transport === 'http';
    if (transport === 'http') {
      neonConfig.fetchFunction = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => fetch(input, {
        ...init,
        signal: init?.signal
          ? AbortSignal.any([init.signal, AbortSignal.timeout(60000)])
          : AbortSignal.timeout(60000),
      });
    }
    const Driver = transport === 'tcp' ? Pool : NeonPool;
    pool = new Driver(poolOptions());
    pool.on('error', (error: Error) => console.error('[database] idle connection error', error.message));
  }
  return pool;
}

interface TestDatabase {
  query<T>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<unknown>;
  close(): Promise<void>;
}

let testDatabase: TestDatabase | undefined;

export function useTestDatabase(database: TestDatabase): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('test database is only allowed in tests');
  testDatabase = database;
}

export async function query<T extends QueryResultRow = Record<string, unknown>>(
  sql: string,
  values: unknown[] = [],
): Promise<T[]> {
  if (testDatabase) return (await testDatabase.query<T>(sql, values)).rows;
  const active = databasePool();
  if (active instanceof NeonPool) return (await active.query<T>(sql, values)).rows;
  return (await active.query<T>(sql, values)).rows;
}

interface DatabaseClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  release(): void;
}

export async function connectDatabase(): Promise<DatabaseClient> {
  // HTTP queries have no session; advisory locks and migration transactions need TCP.
  const active = process.env.RAT_DATABASE_TRANSPORT === 'http'
    ? sessionPool ??= new Pool(poolOptions())
    : databasePool();
  if (active instanceof NeonPool) {
    const client = await active.connect();
    return { query: (sql, values) => client.query(sql, values), release: () => client.release() };
  }
  const client = await active.connect();
  return { query: (sql, values) => client.query(sql, values), release: () => client.release() };
}

export async function closeDb(): Promise<void> {
  if (testDatabase) {
    await testDatabase.close();
    testDatabase = undefined;
  }
  await pool?.end();
  await sessionPool?.end();
  pool = undefined;
  sessionPool = undefined;
}
