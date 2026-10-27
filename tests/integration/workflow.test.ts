import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { SignJWT, importPKCS8 } from 'jose';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { sha256 } from '../../packages/core/src/security.js';
import { verifyPdf } from '../../packages/core/src/pdf-signature.js';
import type { DocumentRecord, SigningRequest, Session } from '../../packages/core/src/types.js';

const base = 'http://127.0.0.1:4100';
const origin = 'http://localhost:5173';
let root: string,
  child: ChildProcess,
  logs = '',
  cookie = '',
  csrf = '';
type Prepared = SigningRequest & { manifestToken: string };
async function api<T>(
  path: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
  headers: Record<string, string> = {},
): Promise<T> {
  const response = await fetch(base + '/api' + path, {
    method,
    headers: {
      origin,
      cookie,
      'x-csrf-token': csrf,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(JSON.stringify(data)), {
      status: response.status,
      code: data.error,
    });
  return data as T;
}
async function token(service: string, audience: string, claims: Record<string, unknown>) {
  const key = await importPKCS8(
    await readFile(join(root, 'keys', service, 'private.pem'), 'utf8'),
    'EdDSA',
  );
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuer('pston:' + service)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime('2m')
    .sign(key);
}
async function internal(
  service: string,
  port: number,
  path: string,
  owner = 'another-owner',
  body?: unknown,
) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      authorization:
        'Bearer ' +
        (await token(service, `pston:${port === 4102 ? 'documents' : 'signing'}`, {
          purpose: 'service',
          sub: owner,
        })),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function preview(doc: DocumentRecord, qr = false) {
  return api<{ id: string; hash: string; verificationId?: string }>(
    `/documents/${doc.id}/preview`,
    { draftVersion: doc.draftVersion, qr },
  );
}
async function prepare(previewId: string, idempotencyKey = randomUUID()) {
  return api<Prepared>('/signing/prepare', {
    previewId,
    certificateId: 'demo-certificate',
    idempotencyKey,
  });
}
async function approve(request: Prepared) {
  return api<{ approvalToken: string }>('/approval/demo', { manifestToken: request.manifestToken });
}
async function startServices() {
  const env = {
    ...process.env,
    PSTON_DATA_DIR: root,
    PSTON_MODE: 'demo',
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    WEB_ORIGIN: origin,
  };
  for (const [i, name] of ['gateway', 'identity', 'documents', 'signing', 'audit'].entries()) {
    Object.assign(env, {
      [`${name.toUpperCase()}_PORT`]: String(4100 + i),
      [`${name.toUpperCase()}_URL`]: `http://127.0.0.1:${4100 + i}`,
    });
  }
  child = spawn(process.execPath, ['scripts/dev.mjs', '--api-only'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk) => {
    logs = (logs + chunk).slice(-16000);
  });
  child.stderr?.on('data', (chunk) => {
    logs = (logs + chunk).slice(-16000);
  });
  let ready = false;
  for (let n = 0; n < 100; n++) {
    try {
      const response = await fetch(base + '/api/session');
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      /* services starting */
    }
    if (child.exitCode !== null) throw new Error(logs);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!ready) throw new Error('Services did not start: ' + logs);
}
async function stopServices() {
  if (child && child.exitCode === null) {
    const stopped = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    await stopped;
  }
}
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'pston-integration-'));
  await startServices();
  const login = await fetch(base + '/api/auth/demo', { method: 'POST', headers: { origin } });
  expect(login.status).toBe(200);
  cookie = login.headers.get('set-cookie')!.split(';')[0];
  csrf = ((await login.json()) as Session).csrf;
});
afterAll(async () => {
  await stopServices();
  if (root) await rm(root, { recursive: true, force: true });
});

describe('real microservice signing workflow', () => {
  let doc: DocumentRecord,
    signed: SigningRequest,
    request: Prepared,
    approval: { approvalToken: string },
    signedBytes: Buffer;

  it('rejects unauthenticated, cross-origin, missing-CSRF and direct service calls', async () => {
    expect((await fetch(base + '/api/documents')).status).toBe(401);
    await expect(
      api('/documents/sample', {}, 'POST', { origin: 'https://attacker.invalid' }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      api('/documents/sample', {}, 'POST', { 'x-csrf-token': '' }),
    ).rejects.toMatchObject({ status: 403 });
    for (const port of [4101, 4102, 4103, 4104])
      expect((await fetch(`http://127.0.0.1:${port}/private`)).status).toBe(401);
    expect((await fetch(base + '/api/internal/prepare')).status).toBe(404);
  });

  it('creates a Thai PDF, rejects stale saves, and keeps originals immutable', async () => {
    doc = await api<DocumentRecord>('/documents/sample', {});
    expect(doc.pages).toBe(1);
    doc = await api<DocumentRecord>(`/documents/${doc.id}/draft`, {
      draftVersion: 0,
      elements: [
        {
          id: randomUUID(),
          type: 'text',
          page: 0,
          x: 0.15,
          y: 0.7,
          width: 0.55,
          height: 0.05,
          fontSize: 16,
          color: '#153f35',
          text: 'ทดสอบลายเซ็น ภาษาไทย กำลังดำเนินการ',
        },
      ],
    });
    await expect(
      api(`/documents/${doc.id}/draft`, { draftVersion: 0, elements: [] }),
    ).rejects.toMatchObject({ code: 'DRAFT_CONFLICT' });
    const original = Buffer.from(
      await (
        await fetch(`${base}/api/documents/${doc.id}/revisions/${doc.revisions[0].id}/file`, {
          headers: { cookie },
        })
      ).arrayBuffer(),
    );
    expect(sha256(original)).toBe(doc.revisions[0].sha256);
    expect((await internal('gateway', 4102, `/documents/${doc.id}`)).status).toBe(404);
  });

  it('binds approval to one document and rejects a gateway-forged approval', async () => {
    const p = await preview(doc, true);
    request = await prepare(p.id);
    const forged = await token('gateway', 'pston:signing-approval', {
      purpose: 'sign-approval',
      sub: 'demo-owner',
      requestId: request.id,
      preparedHash: request.preparedHash,
      documentDigest: request.documentDigest,
      certificateId: request.certificateId,
      nonce: request.nonce,
      method: 'webauthn',
    });
    await expect(
      api(`/signing/${request.id}/execute`, { approvalToken: forged }),
    ).rejects.toMatchObject({ status: 401 });
    approval = await approve(request);
    const other = await prepare(p.id);
    await expect(api(`/signing/${other.id}/execute`, approval)).rejects.toMatchObject({
      code: 'APPROVAL_MISMATCH',
    });
    expect((await internal('gateway', 4103, `/signing/${request.id}`)).status).toBe(404);
  });

  it('signs CMS, verifies with OpenSSL, downloads identical bytes and publishes minimal QR evidence', async () => {
    signed = await api<SigningRequest>(`/signing/${request.id}/execute`, approval);
    expect(signed.state).toBe('signed');
    const updated = await api<DocumentRecord>(`/documents/${doc.id}`);
    expect(updated.revisions).toHaveLength(2);
    expect(updated.revisions[0].sha256).toBe(doc.revisions[0].sha256);
    signedBytes = Buffer.from(
      await (
        await fetch(`${base}/api/documents/${doc.id}/revisions/${signed.revision!.id}/file`, {
          headers: { cookie },
        })
      ).arrayBuffer(),
    );
    expect(sha256(signedBytes)).toBe(signed.revision!.sha256);
    expect(await verifyPdf(signedBytes)).toMatchObject({
      crypto: 'valid',
      trust: 'untrusted',
      timestamp: 'none',
      documentDigest: request.documentDigest,
    });
    const evidence = await (await fetch(`${base}/api/verify/${signed.verificationId}`)).json();
    expect(evidence.sha256).toBe(sha256(signedBytes));
    expect(evidence.owner).toBeUndefined();
    expect(evidence.documentId).toBeUndefined();
    expect(evidence.title).toBeUndefined();
    expect(
      await api(`/verify/${signed.verificationId}/check`, { sha256: sha256(signedBytes) }),
    ).toMatchObject({ matches: true });
    expect(
      await api(`/verify/${signed.verificationId}/check`, { sha256: '0'.repeat(64) }),
    ).toMatchObject({ matches: false });
  });

  it('returns the same result on retry and rejects post-sign edits, appended bytes and content tampering', async () => {
    const repeated = await Promise.all([
      api<SigningRequest>(`/signing/${request.id}/execute`, approval),
      api<SigningRequest>(`/signing/${request.id}/execute`, approval),
    ]);
    expect(repeated.map((r) => r.revision!.id)).toEqual([signed.revision!.id, signed.revision!.id]);
    expect((await api<DocumentRecord>(`/documents/${doc.id}`)).revisions).toHaveLength(2);
    await expect(
      api(`/documents/${doc.id}/draft`, { draftVersion: doc.draftVersion, elements: [] }),
    ).rejects.toMatchObject({ code: 'SIGNED_READ_ONLY' });
    const tampered = Buffer.from(signedBytes);
    tampered[20] ^= 1;
    await expect(verifyPdf(tampered)).rejects.toThrow();
    await expect(
      verifyPdf(Buffer.concat([signedBytes, Buffer.from('\nappended')])),
    ).rejects.toThrow('complete revision');
  });

  it('rejects edits made after approval before using the signing key', async () => {
    const draft = await api<DocumentRecord>(`/documents/${doc.id}/duplicate`, {});
    const p = await preview(draft),
      req = await prepare(p.id),
      auth = await approve(req);
    await api(`/documents/${draft.id}/draft`, { draftVersion: draft.draftVersion, elements: [] });
    await expect(api(`/signing/${req.id}/execute`, auth)).rejects.toMatchObject({
      code: 'DRAFT_CHANGED',
    });
    expect((await api<SigningRequest>(`/signing/${req.id}`)).state).toBe('failed');
    expect((await api<DocumentRecord>(`/documents/${draft.id}`)).revisions).toHaveLength(1);
  });

  it('deduplicates prepare requests and rejects changed payloads for the same key', async () => {
    const draft = await api<DocumentRecord>(`/documents/${doc.id}/duplicate`, {});
    const p = await preview(draft),
      key = randomUUID();
    const req = await prepare(p.id, key);
    expect((await prepare(p.id, key)).id).toBe(req.id);
    await expect(prepare(randomUUID(), key)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    await api('/security/lock', { locked: true });
    await expect(prepare(p.id)).rejects.toMatchObject({ code: 'SIGNING_LOCKED' });
    await expect(api(`/signing/${req.id}/execute`, await approve(req))).rejects.toMatchObject({
      code: 'SIGNING_LOCKED',
    });
    await api('/security/lock', { locked: false });
  });

  it('rejects a signed or active-content PDF on upload', async () => {
    const active = await PDFDocument.create();
    active.addPage();
    active.catalog.set(
      PDFName.of('OpenAction'),
      active.context.obj({ S: 'JavaScript', JS: PDFString.of('app.alert("test")') }),
    );
    for (const pdf of [signedBytes, await active.save()]) {
      const form = new FormData();
      form.set('file', new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }), 'unsafe.pdf');
      const response = await fetch(base + '/api/documents', {
        method: 'POST',
        headers: { origin, cookie, 'x-csrf-token': csrf },
        body: form,
      });
      expect(response.status).toBe(422);
    }
  });

  it('supports recoverable trash and keeps audit hash chain intact', async () => {
    await api(`/documents/${doc.id}`, undefined, 'DELETE');
    await expect(api(`/documents/${doc.id}`)).rejects.toMatchObject({ status: 404 });
    expect(
      (await api<{ documents: DocumentRecord[] }>('/documents?scope=trash')).documents.some(
        (d) => d.id === doc.id,
      ),
    ).toBe(true);
    await api(`/documents/${doc.id}/restore`, {});
    expect((await api<DocumentRecord>(`/documents/${doc.id}`)).revisions).toHaveLength(2);
    await expect
      .poll(
        async () =>
          (await api<{ events: { type: string }[] }>('/audit/events')).events.some(
            (e) => e.type === 'signing.completed',
          ),
        { timeout: 10000 },
      )
      .toBe(true);
    expect(await api('/audit/integrity')).toMatchObject({ valid: true });
  });

  it('recovers a persisted result after restart without creating another signature', async () => {
    await stopServices();
    const db = new DatabaseSync(join(root, 'services', 'signing', 'store.sqlite'));
    // Simulate process death between document archive and recording the response.
    db.prepare('UPDATE records SET data=? WHERE kind=? AND id=?').run(
      JSON.stringify({
        ...signed,
        state: 'signing',
        expiresAt: new Date(Date.now() - 600001).toISOString(),
      }),
      'requests',
      signed.id,
    );
    const unknown = {
      ...signed,
      id: randomUUID(),
      state: 'signing',
      expiresAt: new Date(Date.now() - 600001).toISOString(),
      revision: undefined,
    };
    db.prepare('INSERT INTO records(kind,id,owner,data,updated) VALUES(?,?,?,?,?)').run(
      'requests',
      unknown.id,
      'demo-owner',
      JSON.stringify(unknown),
      new Date().toISOString(),
    );
    db.close();
    await startServices();
    expect((await api<SigningRequest>(`/signing/${signed.id}`)).state).toBe('pending_review');
    const recovered = await api<SigningRequest>(`/signing/${signed.id}/reconcile`, {});
    expect(recovered.state).toBe('signed');
    expect(recovered.revision!.id).toBe(signed.revision!.id);
    expect((await api<DocumentRecord>(`/documents/${doc.id}`)).revisions).toHaveLength(2);
    await expect(api(`/signing/${unknown.id}/reconcile`, {})).rejects.toMatchObject({
      code: 'OUTCOME_UNKNOWN',
    });
    expect((await api<SigningRequest>(`/signing/${unknown.id}`)).state).toBe('pending_review');
  });

  it('revokes a logged-out session', async () => {
    await api('/auth/logout', {});
    await expect(api('/documents')).rejects.toMatchObject({ status: 401 });
  });
});
