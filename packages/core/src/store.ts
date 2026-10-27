import { DatabaseSync } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { serviceDir } from './config.js';
import type { AuditEvent, ServiceName } from './types.js';
import { AppError } from './errors.js';
import { now } from './security.js';

type Row = Record<string, string | number>;
export interface SqlConnection {
  query(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>;
  release(): void;
}
export interface SqlPool {
  connect(): Promise<SqlConnection>;
  end(): Promise<void>;
}

/** Short transactions serialize per service across instances. Never call an
 * external service or perform PDF/object-storage work inside a transaction. */
export class Store {
  private db?: DatabaseSync;
  private pool?: SqlPool;
  private context = new AsyncLocalStorage<SqlConnection>();
  private queue: Promise<void> = Promise.resolve();
  private constructor(public service: ServiceName) {}

  static async open(service: ServiceName, path?: string, pool?: SqlPool) {
    const store = new Store(service);
    if (
      process.env.K_SERVICE &&
      !pool &&
      !path &&
      ['PGHOST', 'PGDATABASE', 'PGUSER', 'PGPASSWORD'].some((key) => !process.env[key])
    )
      throw new Error('Cloud Run PostgreSQL credentials and socket configuration are required');
    if (pool || (!path && process.env.PSTON_STORE === 'postgres')) {
      store.pool =
        pool ??
        new Pool({
          host: process.env.PGHOST,
          database: process.env.PGDATABASE,
          user: process.env.PGUSER,
          password: process.env.PGPASSWORD,
          max: 3,
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 15000,
          statement_timeout: 30000,
        });
    } else {
      store.db = new DatabaseSync(path ?? join(serviceDir(service), 'store.sqlite'));
      store.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    }
    await store.transaction(async () => {
      await store.query(
        'CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL,id TEXT NOT NULL,owner TEXT NOT NULL,data TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,updated TEXT NOT NULL,PRIMARY KEY(kind,id))',
      );
      await store.query('CREATE INDEX IF NOT EXISTS records_owner ON records(kind,owner,updated)');
      await store.query(
        'CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY,data TEXT NOT NULL)',
      );
      if (service === 'audit') {
        const sequence = store.pool ? 'BIGSERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
        await store.query(
          `CREATE TABLE IF NOT EXISTS audit (sequence ${sequence},id TEXT UNIQUE NOT NULL,owner TEXT NOT NULL,data TEXT NOT NULL,previous_hash TEXT NOT NULL,hash TEXT NOT NULL)`,
        );
        await store.query('CREATE INDEX IF NOT EXISTS audit_owner ON audit(owner,sequence)');
      }
    });
    return store;
  }
  async query(sql: string, values: (string | number)[] = []): Promise<Row[]> {
    const connection = this.context.getStore();
    if (!connection) return this.transaction(() => this.query(sql, values));
    return (await connection.query(sql, values)).rows;
  }
  async get<T>(kind: string, id: string): Promise<T | undefined> {
    const [row] = await this.query('SELECT data FROM records WHERE kind=? AND id=?', [kind, id]);
    return row ? (JSON.parse(String(row.data)) as T) : undefined;
  }
  async list<T>(kind: string, owner?: string): Promise<T[]> {
    const rows =
      owner === undefined
        ? await this.query('SELECT data FROM records WHERE kind=? ORDER BY updated DESC', [kind])
        : await this.query(
            'SELECT data FROM records WHERE kind=? AND owner=? ORDER BY updated DESC',
            [kind, owner],
          );
    return rows.map((row) => JSON.parse(String(row.data)) as T);
  }
  async put<T>(kind: string, id: string, owner: string, data: T) {
    await this.query(
      'INSERT INTO records(kind,id,owner,data,updated) VALUES(?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data,version=records.version+1,updated=excluded.updated WHERE records.owner=excluded.owner',
      [kind, id, owner, JSON.stringify(data), now()],
    );
  }
  async insert<T>(kind: string, id: string, owner: string, data: T) {
    const rows = await this.query(
      'INSERT INTO records(kind,id,owner,data,updated) VALUES(?,?,?,?,?) ON CONFLICT(kind,id) DO NOTHING RETURNING id',
      [kind, id, owner, JSON.stringify(data), now()],
    );
    if (!rows.length) throw new AppError(409, 'ALREADY_EXISTS', 'Record already exists');
  }
  async remove(kind: string, id: string) {
    await this.query('DELETE FROM records WHERE kind=? AND id=?', [kind, id]);
  }
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.context.getStore()) return fn();
    let unlock: (() => void) | undefined;
    let connection: SqlConnection;
    if (this.pool) {
      const raw = await this.pool.connect();
      connection = {
        query: (sql, values) => {
          let index = 0;
          return raw.query(
            sql.replace(/\?/g, () => `$${++index}`),
            values,
          );
        },
        release: () => raw.release(),
      };
    } else {
      const prior = this.queue;
      this.queue = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      await prior;
      connection = {
        query: async (sql, values = []) => ({
          rows: this.db!.prepare(sql).all(...(values as (string | number)[])) as Row[],
        }),
        release: () => unlock!(),
      };
    }
    let started = false;
    try {
      await connection.query(this.pool ? 'BEGIN' : 'BEGIN IMMEDIATE');
      started = true;
      if (this.pool)
        await connection.query('SELECT pg_advisory_xact_lock(714203, ?)', [
          ['gateway', 'identity', 'documents', 'signing', 'audit'].indexOf(this.service),
        ]);
      const result = await this.context.run(connection, fn);
      await connection.query('COMMIT');
      return result;
    } catch (error) {
      if (started) await connection.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      connection.release();
    }
  }
  async event(
    owner: string,
    type: string,
    resourceId: string,
    details: AuditEvent['details'] = {},
    outcome: AuditEvent['outcome'] = 'success',
  ) {
    const event: AuditEvent = {
      id: randomUUID(),
      owner,
      type,
      service: this.service,
      occurredAt: now(),
      resourceId,
      details,
      outcome,
    };
    await this.query('INSERT INTO outbox(id,data) VALUES(?,?)', [event.id, JSON.stringify(event)]);
    return event;
  }
  async pendingEvents(): Promise<AuditEvent[]> {
    return (await this.query('SELECT data FROM outbox ORDER BY id LIMIT 100')).map(
      (row) => JSON.parse(String(row.data)) as AuditEvent,
    );
  }
  async acknowledge(id: string) {
    await this.query('DELETE FROM outbox WHERE id=?', [id]);
  }
  async close() {
    if (this.pool) await this.pool.end();
    else {
      await this.queue;
      this.db!.close();
    }
  }
}
