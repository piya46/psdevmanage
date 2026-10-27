import { databaseReadiness } from '../../../packages/core/src/http.js';
import { BlobStore } from '../../../packages/core/src/blobs.js';
import { randomUUID, randomBytes } from 'node:crypto';
import { z } from 'zod';
import multipart from '@fastify/multipart';
import {
  createApp,
  internalAuth,
  actor,
  caller,
  listen,
  startOutbox,
} from '../../../packages/core/src/http.js';
import { Store } from '../../../packages/core/src/store.js';
import { maxPdfBytes, mode, webOrigin } from '../../../packages/core/src/config.js';
import { sha256, now } from '../../../packages/core/src/security.js';
import { ensure } from '../../../packages/core/src/errors.js';
import { preparedDigest, verifyPdf } from '../../../packages/core/src/pdf-signature.js';
import type {
  DocumentRecord,
  CertificateProfile,
  Revision,
} from '../../../packages/core/src/types.js';
import { pdfTask } from './worker.js';
interface Preview {
  id: string;
  owner: string;
  documentId: string;
  draftVersion: number;
  hash: string;
  qr: boolean;
  verificationId?: string;
  createdAt: string;
}
interface Prepared {
  id: string;
  owner: string;
  documentId: string;
  previewId: string;
  preparedHash: string;
  documentDigest: string;
  certificate: CertificateProfile;
  createdAt: string;
}
const app = await createApp('documents');
const store = await Store.open('documents');
databaseReadiness(app, store);
const blobs = await BlobStore.open('documents');
await app.register(multipart, { limits: { fileSize: maxPdfBytes, files: 1, fields: 2, parts: 3 } });
await internalAuth(app, 'documents', ['gateway', 'signing']);
startOutbox(store, app);
const idSchema = z.uuid();
const elementSchema = z.object({
  id: z.uuid(),
  type: z.enum(['text', 'date', 'stamp', 'signature']),
  page: z.number().int().min(0).max(299),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().min(0.01).max(1),
  height: z.number().min(0.005).max(1),
  fontSize: z.number().min(6).max(72),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  text: z.string().max(1500),
  image: z
    .string()
    .max(750000)
    .regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/)
    .optional(),
});
async function getDoc(id: string, owner: string, includeDeleted = false) {
  idSchema.parse(id);
  const doc = await store.get<DocumentRecord>('documents', id);
  ensure(
    doc && doc.owner === owner && (includeDeleted || !doc.deletedAt),
    404,
    'DOCUMENT_NOT_FOUND',
    'ไม่พบเอกสาร',
  );
  return doc;
}
async function createDocument(owner: string, title: string, pdf: Buffer) {
  ensure(
    pdf.length <= maxPdfBytes && pdf.subarray(0, 5).toString() === '%PDF-',
    400,
    'INVALID_PDF',
    `กรุณาเลือก PDF ขนาดไม่เกิน ${maxPdfBytes / 1024 / 1024} MB`,
  );
  const info = await pdfTask<{
    pages: number;
  }>({
    operation: 'inspect',
    pdf: pdf.toString('base64'),
  });
  const id = randomUUID(),
    revisionId = randomUUID();
  await blobs.write(revisionId, pdf);
  const doc: DocumentRecord = {
    id,
    owner,
    title: [...title]
      .filter((c) => c.charCodeAt(0) >= 32)
      .join('')
      .slice(0, 200),
    bytes: pdf.length,
    pages: info.pages,
    createdAt: now(),
    updatedAt: now(),
    status: 'draft',
    draftVersion: 0,
    elements: [],
    revisions: [
      {
        id: revisionId,
        kind: 'original',
        sha256: sha256(pdf),
        bytes: pdf.length,
        createdAt: now(),
      },
    ],
  };
  await store.transaction(async () => {
    await store.insert('documents', id, owner, doc);
    await store.event(owner, 'document.uploaded', id, {
      sha256: doc.revisions[0].sha256,
      pages: doc.pages,
      bytes: doc.bytes,
    });
  });
  return doc;
}
app.post('/documents', async (req) => {
  caller(req, ['gateway']);
  const owner = actor(req);
  const file = await req.file();
  ensure(file, 400, 'FILE_REQUIRED', 'กรุณาเลือกไฟล์ PDF');
  const buffer = await file.toBuffer();
  ensure(!file.file.truncated, 413, 'FILE_TOO_LARGE', `ไฟล์เกิน ${maxPdfBytes / 1024 / 1024} MB`);
  return createDocument(owner, file.filename, buffer);
});
app.post('/documents/sample', async (req) => {
  caller(req, ['gateway']);
  ensure(mode === 'demo', 404, 'NOT_FOUND', 'Not found');
  const result = await pdfTask<{
    pdf: string;
  }>({ operation: 'sample' });
  return createDocument(actor(req), 'เอกสารตัวอย่าง PSTON.pdf', Buffer.from(result.pdf, 'base64'));
});
app.get('/documents', async (req) => {
  const query = z
    .object({
      q: z.string().max(200).default(''),
      status: z.enum(['all', 'draft', 'signed']).default('all'),
      scope: z.enum(['active', 'trash']).default('active'),
    })
    .parse(req.query);
  const all = await store.list<DocumentRecord>('documents', actor(req));
  const documents = all.filter(
    (d) =>
      (query.scope === 'trash' ? !!d.deletedAt : !d.deletedAt) &&
      (query.status === 'all' || d.status === query.status) &&
      d.title.toLocaleLowerCase().includes(query.q.toLocaleLowerCase()),
  );
  return {
    documents: documents.slice(0, 200),
    total: documents.length,
    stats: {
      total: all.filter((d) => !d.deletedAt).length,
      signed: all.filter((d) => !d.deletedAt && d.status === 'signed').length,
      draft: all.filter((d) => !d.deletedAt && d.status === 'draft').length,
      bytes: all
        .filter((d) => !d.deletedAt)
        .reduce((sum, d) => sum + d.revisions.reduce((s, r) => s + r.bytes, 0), 0),
    },
  };
});
app.get<{
  Params: {
    id: string;
  };
}>('/documents/:id', async (req) => await getDoc(req.params.id, actor(req)));
app.post<{
  Params: {
    id: string;
  };
}>('/documents/:id/draft', async (req) => {
  caller(req, ['gateway']);
  const owner = actor(req);
  const body = z
    .object({
      draftVersion: z.number().int().nonnegative(),
      elements: z.array(elementSchema).max(100),
    })
    .parse(req.body);
  return await store.transaction(async () => {
    const doc = await getDoc(req.params.id, owner);
    ensure(
      doc.status === 'draft',
      409,
      'SIGNED_READ_ONLY',
      'เอกสารที่ลงนามแล้วแก้ไขไม่ได้ กรุณาสร้างสำเนาต้นฉบับ',
    );
    ensure(
      doc.draftVersion === body.draftVersion,
      409,
      'DRAFT_CONFLICT',
      'เอกสารถูกแก้ไขจากหน้าต่างอื่น กรุณาเปิดใหม่',
    );
    ensure(
      body.elements.every(
        (el) =>
          el.page < doc.pages &&
          el.x + el.width <= 1.02 &&
          el.y + el.height <= 1.02 &&
          (el.type !== 'signature' || el.image),
      ),
      400,
      'INVALID_POSITION',
      'องค์ประกอบอยู่นอกหน้าหรือไม่มีภาพลายเซ็น',
    );
    doc.elements = body.elements;
    doc.draftVersion++;
    doc.updatedAt = now();
    await store.put('documents', doc.id, owner, doc);
    await store.event(owner, 'document.draft_saved', doc.id, { version: doc.draftVersion });
    return doc;
  });
});
app.post<{
  Params: {
    id: string;
  };
}>('/documents/:id/preview', async (req) => {
  caller(req, ['gateway']);
  const owner = actor(req);
  const body = z
    .object({ draftVersion: z.number().int(), qr: z.boolean().default(false) })
    .parse(req.body);
  const doc = await getDoc(req.params.id, owner);
  ensure(
    doc.status === 'draft' && doc.draftVersion === body.draftVersion,
    409,
    'DRAFT_CONFLICT',
    'กรุณาบันทึกและตรวจร่างฉบับล่าสุด',
  );
  const id = randomUUID();
  const verificationId = body.qr ? randomBytes(24).toString('base64url') : undefined;
  const original = await blobs.read(doc.revisions[0].id);
  ensure(
    sha256(original) === doc.revisions[0].sha256,
    409,
    'INTEGRITY_FAILURE',
    'Original file integrity check failed',
  );
  const result = await pdfTask<{
    pdf: string;
  }>({
    operation: 'compose',
    pdf: original.toString('base64'),
    elements: doc.elements,
    testOnly: mode === 'demo',
    qr: verificationId ? `${webOrigin}/verify/${verificationId}` : undefined,
  });
  const pdf = Buffer.from(result.pdf, 'base64');
  ensure(pdf.length <= maxPdfBytes, 413, 'PDF_TOO_LARGE', 'PDF หลังประมวลผลมีขนาดเกินกำหนด');
  const preview: Preview = {
    id,
    owner,
    documentId: doc.id,
    draftVersion: doc.draftVersion,
    hash: sha256(pdf),
    qr: body.qr,
    verificationId,
    createdAt: now(),
  };
  await blobs.write(id, pdf);
  await store.transaction(async () => {
    ensure(
      (await getDoc(doc.id, owner)).draftVersion === doc.draftVersion,
      409,
      'DRAFT_CONFLICT',
      'Draft changed during preview',
    );
    await store.insert('previews', id, owner, preview);
  });
  return preview;
});
app.get<{
  Params: {
    id: string;
  };
}>('/previews/:id/file', async (req, reply) => {
  const record = await store.get<Preview>('previews', idSchema.parse(req.params.id));
  ensure(record && record.owner === actor(req), 404, 'NOT_FOUND', 'Preview not found');
  const bytes = await blobs.read(record.id);
  ensure(sha256(bytes) === record.hash, 409, 'INTEGRITY_FAILURE', 'Preview integrity check failed');
  return reply.type('application/pdf').header('cache-control', 'private, no-store').send(bytes);
});
app.get<{
  Params: {
    id: string;
    revisionId: string;
  };
}>('/documents/:id/revisions/:revisionId/file', async (req, reply) => {
  const doc = await getDoc(req.params.id, actor(req));
  const revision = doc.revisions.find((r) => r.id === req.params.revisionId);
  ensure(revision, 404, 'NOT_FOUND', 'Revision not found');
  const bytes = await blobs.read(revision.id);
  ensure(
    sha256(bytes) === revision.sha256,
    409,
    'INTEGRITY_FAILURE',
    'File integrity check failed',
  );
  await store.event(doc.owner, 'document.downloaded', doc.id, {
    revisionId: revision.id,
    sha256: revision.sha256,
  });
  return reply
    .type('application/pdf')
    .header('cache-control', 'private, no-store')
    .header(
      'content-disposition',
      `inline; filename="pston-${revision.kind}.pdf"; filename*=UTF-8''${encodeURIComponent(doc.title)}`,
    )
    .send(bytes);
});
app.post<{
  Params: {
    id: string;
  };
}>('/documents/:id/duplicate', async (req) => {
  caller(req, ['gateway']);
  const doc = await getDoc(req.params.id, actor(req));
  const bytes = await blobs.read(doc.revisions[0].id);
  ensure(
    sha256(bytes) === doc.revisions[0].sha256,
    409,
    'INTEGRITY_FAILURE',
    'Original integrity failure',
  );
  return createDocument(doc.owner, doc.title.replace(/\.pdf$/i, '') + ' (สำเนา).pdf', bytes);
});
app.delete<{
  Params: {
    id: string;
  };
}>('/documents/:id', async (req) => {
  caller(req, ['gateway']);
  const owner = actor(req);
  return await store.transaction(async () => {
    const doc = await getDoc(req.params.id, owner);
    doc.deletedAt = now();
    await store.put('documents', doc.id, owner, doc);
    await store.event(owner, 'document.soft_deleted', doc.id);
    return { ok: true };
  });
});
app.post<{
  Params: {
    id: string;
  };
}>('/documents/:id/restore', async (req) => {
  caller(req, ['gateway']);
  const owner = actor(req);
  return await store.transaction(async () => {
    const doc = await getDoc(req.params.id, owner, true);
    delete doc.deletedAt;
    await store.put('documents', doc.id, owner, doc);
    await store.event(owner, 'document.restored', doc.id);
    return doc;
  });
});
app.post('/internal/prepare', async (req) => {
  caller(req, ['signing']);
  const owner = actor(req);
  const body = z
    .object({
      requestId: z.uuid(),
      previewId: z.uuid(),
      createdAt: z.iso.datetime(),
      certificate: z.custom<CertificateProfile>(),
    })
    .parse(req.body);
  const preview = await store.get<Preview>('previews', body.previewId);
  ensure(preview && preview.owner === owner, 404, 'NOT_FOUND', 'Preview not found');
  const doc = await getDoc(preview.documentId, owner);
  ensure(
    doc.status === 'draft' && doc.draftVersion === preview.draftVersion,
    409,
    'DRAFT_CONFLICT',
    'Draft changed; preview and approve again',
  );
  const source = await blobs.read(preview.id);
  ensure(sha256(source) === preview.hash, 409, 'INTEGRITY_FAILURE', 'Preview integrity failure');
  const result = await pdfTask<{
    pdf: string;
  }>({
    operation: 'prepare',
    pdf: source.toString('base64'),
    name: body.certificate.subject,
    createdAt: body.createdAt,
  });
  const pdf = Buffer.from(result.pdf, 'base64');
  ensure(pdf.length <= maxPdfBytes, 413, 'PDF_TOO_LARGE', 'PDF หลังประมวลผลมีขนาดเกินกำหนด');
  const prepared: Prepared = {
    id: body.requestId,
    owner,
    documentId: doc.id,
    previewId: preview.id,
    preparedHash: sha256(pdf),
    documentDigest: preparedDigest(pdf).digest,
    certificate: body.certificate,
    createdAt: body.createdAt,
  };
  await blobs.write(prepared.id, pdf);
  await store.insert('prepared', prepared.id, owner, prepared);
  return {
    ...prepared,
    previewHash: preview.hash,
    draftVersion: preview.draftVersion,
    qr: preview.qr,
    verificationId: preview.verificationId,
  };
});
app.get<{
  Params: {
    id: string;
  };
}>('/internal/prepared/:id', async (req) => {
  caller(req, ['signing']);
  const prepared = await store.get<Prepared>('prepared', idSchema.parse(req.params.id));
  ensure(
    prepared && prepared.owner === actor(req),
    404,
    'NOT_FOUND',
    'Prepared document not found',
  );
  const preview = (await store.get<Preview>('previews', prepared.previewId))!;
  const doc = await getDoc(prepared.documentId, prepared.owner);
  ensure(
    doc.draftVersion === preview.draftVersion && doc.status === 'draft',
    409,
    'DRAFT_CHANGED',
    'Document changed after approval',
  );
  const pdf = await blobs.read(prepared.id);
  ensure(
    sha256(pdf) === prepared.preparedHash,
    409,
    'INTEGRITY_FAILURE',
    'Prepared integrity failure',
  );
  return {
    pdf: pdf.toString('base64'),
    preparedHash: prepared.preparedHash,
    documentDigest: prepared.documentDigest,
  };
});
app.post('/internal/archive', async (req) => {
  caller(req, ['signing']);
  const owner = actor(req);
  const body = z
    .object({ requestId: z.uuid(), pdf: z.string().max(75 * 1024 * 1024) })
    .parse(req.body);
  const prepared = await store.get<Prepared>('prepared', body.requestId);
  ensure(prepared && prepared.owner === owner, 404, 'NOT_FOUND', 'Prepared document not found');
  const existing = await store.get<{
    revision: Revision;
  }>('archived', body.requestId);
  if (existing) return existing;
  const pdf = Buffer.from(body.pdf, 'base64');
  const verification = await verifyPdf(pdf);
  ensure(
    verification.documentDigest === prepared.documentDigest &&
      verification.certificateFingerprint === prepared.certificate.fingerprint,
    409,
    'SIGNED_CONTENT_MISMATCH',
    'Signed bytes or certificate do not match the approved document',
  );
  const preview = (await store.get<Preview>('previews', prepared.previewId))!;
  const revision: Revision = {
    id: randomUUID(),
    kind: 'signed',
    sha256: sha256(pdf),
    bytes: pdf.length,
    createdAt: now(),
    requestId: body.requestId,
    verificationId: preview.verificationId,
  };
  await blobs.write(revision.id, pdf);
  return await store.transaction(async () => {
    const prior = await store.get<{
      revision: Revision;
    }>('archived', body.requestId);
    if (prior) return prior;
    const doc = await getDoc(prepared.documentId, owner);
    ensure(
      doc.status === 'draft',
      409,
      'SIGNED_READ_ONLY',
      'A signed revision already exists; duplicate the original for a new signing',
    );
    ensure(
      doc.draftVersion === preview.draftVersion,
      409,
      'DRAFT_CHANGED',
      'Draft changed during signing',
    );
    doc.revisions.push(revision);
    doc.status = 'signed';
    doc.bytes = revision.bytes;
    doc.updatedAt = now();
    await store.put('documents', doc.id, owner, doc);
    const result = { revision, verification };
    await store.insert('archived', body.requestId, owner, result);
    if (preview.verificationId)
      await store.insert('verification', preview.verificationId, owner, {
        id: preview.verificationId,
        sha256: revision.sha256,
        createdAt: revision.createdAt,
        testOnly: prepared.certificate.testOnly,
        crypto: verification.crypto,
        trust: verification.trust,
        timestamp: verification.timestamp,
        scope: 'Only this stored revision is recorded; external signatures are unknown',
      });
    await store.event(owner, 'document.signed', doc.id, {
      revisionId: revision.id,
      sha256: revision.sha256,
      requestId: body.requestId,
      testOnly: prepared.certificate.testOnly,
    });
    return result;
  });
});
app.get<{
  Params: {
    id: string;
  };
}>('/verification/:id', async (req) => {
  caller(req, ['gateway']);
  const id = z
    .string()
    .regex(/^[A-Za-z0-9_-]{32}$/)
    .parse(req.params.id);
  const record = await store.get<Record<string, unknown>>('verification', id);
  ensure(record, 404, 'VERIFICATION_NOT_FOUND', 'ยังไม่มีหลักฐานการลงนามสำหรับรหัสนี้');
  return record;
});
app.post<{
  Params: {
    id: string;
  };
}>('/documents/:id/verify', async (req) => {
  const doc = await getDoc(req.params.id, actor(req));
  const { revisionId } = z.object({ revisionId: z.uuid() }).parse(req.body);
  const revision = doc.revisions.find((r) => r.id === revisionId);
  ensure(revision, 404, 'NOT_FOUND', 'Revision not found');
  const bytes = await blobs.read(revision.id);
  ensure(sha256(bytes) === revision.sha256, 409, 'INTEGRITY_FAILURE', 'Stored hash mismatch');
  if (revision.kind === 'original')
    return { sha256: revision.sha256, crypto: 'unsigned', trust: 'not_applicable' };
  const result = await verifyPdf(bytes);
  await store.event(doc.owner, 'document.verified', doc.id, { revisionId, crypto: result.crypto });
  return result;
});
await listen(app, 'documents', 3002);
