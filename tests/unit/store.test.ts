import { describe, expect, it } from 'vitest';
import { Store, type SqlPool, type SqlConnection } from '../../packages/core/src/store.js';
import { PGlite } from '@electric-sql/pglite';

for (const backend of ['sqlite', 'postgres'] as const) {
  async function open() {
    if (backend === 'sqlite') return Store.open('documents', ':memory:');
    const db = new PGlite();
    let queue = Promise.resolve();
    const pool: SqlPool = {
      async connect() {
        const prior = queue;
        let release!: () => void;
        queue = new Promise<void>((resolve) => {
          release = resolve;
        });
        await prior;
        return { query: (sql, values) => db.query(sql, values), release } as SqlConnection;
      },
      end: () => db.close(),
    };
    return Store.open('documents', undefined, pool);
  }
  describe(`${backend}: transactions and durable audit outbox`, () => {
    it('rolls back business state and audit together even across async work', async () => {
      const store = await open();
      try {
        await expect(
          store.transaction(async () => {
            await store.insert('documents', 'one', 'owner-a', { title: 'draft' });
            await store.event('owner-a', 'document.created', 'one');
            await Promise.resolve();
            throw new Error('simulated failure');
          }),
        ).rejects.toThrow('simulated failure');
        expect(await store.get('documents', 'one')).toBeUndefined();
        expect(await store.pendingEvents()).toEqual([]);
      } finally {
        await store.close();
      }
    });
    it('preserves ownership, rejects duplicate claims and retains unacknowledged audit', async () => {
      const store = await open();
      try {
        await store.transaction(async () => {
          await store.insert('requests', 'one', 'owner-a', { state: 'prepared' });
          await store.event('owner-a', 'signing.prepared', 'one');
        });
        await store.put('requests', 'one', 'owner-b', { state: 'signed' });
        expect(await store.list('requests', 'owner-b')).toEqual([]);
        expect(await store.get('requests', 'one')).toEqual({ state: 'prepared' });
        await expect(store.insert('requests', 'one', 'owner-a', {})).rejects.toThrow(
          'Record already exists',
        );
        const [event] = await store.pendingEvents();
        expect((await store.pendingEvents())[0].id).toBe(event.id);
        await store.acknowledge(event.id);
        expect(await store.pendingEvents()).toEqual([]);
      } finally {
        await store.close();
      }
    });
    it('permits exactly one competing transaction to consume an approval', async () => {
      const store = await open();
      try {
        await store.insert('challenges', 'one', 'owner', { used: false });
        const results = await Promise.allSettled(
          Array.from({ length: 8 }, () =>
            store.transaction(async () => {
              const challenge = await store.get<{ used: boolean }>('challenges', 'one');
              if (challenge!.used) throw new Error('already used');
              await new Promise((resolve) => setTimeout(resolve, 2));
              await store.put('challenges', 'one', 'owner', { used: true });
              await store.event('owner', 'approved', 'one');
            }),
          ),
        );
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        expect(await store.pendingEvents()).toHaveLength(1);
      } finally {
        await store.close();
      }
    });
  });
}
