import { databaseReadiness } from '../../../packages/core/src/http.js';
import { z } from 'zod';
import { createApp, internalAuth, actor, caller, listen } from '../../../packages/core/src/http.js';
import { Store } from '../../../packages/core/src/store.js';
import { canonical, sha256 } from '../../../packages/core/src/security.js';
import type { AuditRecord } from '../../../packages/core/src/types.js';
import { ensure } from '../../../packages/core/src/errors.js';

const app = await createApp('audit');
const store = await Store.open('audit');
databaseReadiness(app, store);
await internalAuth(app, 'audit', ['gateway', 'identity', 'documents', 'signing']);
const eventSchema = z.object({
  id: z.uuid(),
  owner: z.string().min(1).max(200),
  type: z.string().max(100),
  service: z.enum(['gateway', 'identity', 'documents', 'signing', 'audit']),
  occurredAt: z.iso.datetime(),
  resourceId: z.string().max(200),
  outcome: z.enum(['success', 'failure']),
  details: z.record(z.string().max(80), z.union([z.string().max(500), z.number(), z.boolean()])),
});
app.post('/events', async (req) => {
  caller(req, ['identity', 'documents', 'signing']);
  const event = eventSchema.parse(req.body);
  ensure(
    event.owner === actor(req) && event.service === req.caller,
    403,
    'AUDIT_ACTOR_MISMATCH',
    'Audit identity mismatch',
  );
  return store.transaction(async () => {
    const [existing] = await store.query('SELECT hash,data FROM audit WHERE id=?', [event.id]);
    const data = canonical(event);
    if (existing) {
      ensure(
        existing.data === data,
        409,
        'AUDIT_EVENT_CONFLICT',
        'Event ID already has different content',
      );
      return { hash: existing.hash };
    }
    const previous = String(
      (await store.query('SELECT hash FROM audit ORDER BY sequence DESC LIMIT 1'))[0]?.hash ??
        '0'.repeat(64),
    );
    const hash = sha256(previous + data);
    await store.query('INSERT INTO audit(id,owner,data,previous_hash,hash) VALUES(?,?,?,?,?)', [
      event.id,
      event.owner,
      data,
      previous,
      hash,
    ]);
    return { hash };
  });
});
app.get('/events', async (req) => {
  const owner = actor(req);
  const q = z.object({ resourceId: z.string().optional() }).parse(req.query);
  const rows = await store.query(
    'SELECT * FROM audit WHERE owner=? ORDER BY sequence DESC LIMIT 200',
    [owner],
  );
  const events: AuditRecord[] = rows.map((row) => ({
    ...JSON.parse(row.data as string),
    sequence: Number(row.sequence),
    previousHash: String(row.previous_hash),
    hash: String(row.hash),
  }));
  return { events: q.resourceId ? events.filter((e) => e.resourceId === q.resourceId) : events };
});
app.get('/integrity', async (req) => {
  actor(req);
  let previous = '0'.repeat(64);
  let count = 0;
  for (const row of await store.query('SELECT * FROM audit ORDER BY sequence')) {
    if (row.previous_hash !== previous || sha256(previous + (row.data as string)) !== row.hash)
      return {
        valid: false,
        checked: count,
        failedAt: row.sequence,
        scope: 'stored hash chain; no independent checkpoint',
      };
    previous = row.hash as string;
    count++;
  }
  return {
    valid: true,
    checked: count,
    head: previous,
    scope: 'stored hash chain; no independent checkpoint',
  };
});
await listen(app, 'audit', 3004);
