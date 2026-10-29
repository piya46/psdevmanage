import { databaseReadiness } from '../../../packages/core/src/http.js';
import { BlobStore } from '../../../packages/core/src/blobs.js';
import { randomUUID, randomBytes, X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  createApp,
  internalAuth,
  actor,
  listen,
  startOutbox,
  rpc,
} from '../../../packages/core/src/http.js';
import { Store } from '../../../packages/core/src/store.js';
import { mode, serviceDir } from '../../../packages/core/src/config.js';
import {
  sha256,
  now,
  canonical,
  issueToken,
  verifyToken,
} from '../../../packages/core/src/security.js';
import { ensure, AppError } from '../../../packages/core/src/errors.js';
import { verifyPdf } from '../../../packages/core/src/pdf-signature.js';
import type {
  CertificateProfile,
  SigningRequest,
  Revision,
} from '../../../packages/core/src/types.js';
import { DemoSigningProvider, HsmSigningProvider } from './provider.js';
import { CloudHsm } from './kms.js';
import {
  CredentialImports,
  registerCertificateImports,
  type SigningCredential,
} from './credentials.js';
import { validateSigningTrust } from '../../../packages/core/src/certificate-trust.js';
const app = await createApp('signing');
const store = await Store.open('signing');
databaseReadiness(app, store);
const kms =
  process.env.PSTON_SIGNING_PROVIDER === 'google-cloud-hsm'
    ? new CloudHsm(process.env.PSTON_KMS_KEY_RING ?? '')
    : undefined;
const results = await BlobStore.open('signing');
await internalAuth(app, 'signing', ['gateway']);
startOutbox(store, app);
if (kms) registerCertificateImports(app, new CredentialImports(store, kms));
function certificateRecord(
  cert: X509Certificate,
  owner: string,
  id: string,
  label: string,
  testOnly = false,
): CertificateProfile {
  return {
    id,
    owner,
    label,
    subject: cert.subject,
    issuer: cert.issuer,
    serial: cert.serialNumber,
    fingerprint: sha256(cert.raw),
    validFrom: new Date(cert.validFrom).toISOString(),
    validTo: new Date(cert.validTo).toISOString(),
    algorithm: cert.publicKey.asymmetricKeyType ?? 'unknown',
    provider: testOnly ? 'demo' : 'certificate-only',
    canSign: testOnly && mode === 'demo',
    testOnly,
  };
}
async function certificates(owner: string) {
  const all = await store.list<CertificateProfile>('certificates', owner);
  for (const cert of all) {
    if (cert.provider === 'tdid') {
      const credential = await store.get<SigningCredential>('signing_credentials', cert.id);
      cert.canSign =
        !!kms &&
        credential?.owner === owner &&
        credential.enabled &&
        Date.parse(cert.validFrom) <= Date.now() &&
        Date.now() < Date.parse(cert.validTo);
    }
  }
  if (mode === 'demo')
    all.unshift(
      certificateRecord(
        new X509Certificate(
          await readFile(
            process.env.PSTON_DEMO_CERT_FILE ?? join(serviceDir('signing'), 'demo', 'cert.pem'),
          ),
        ),
        owner,
        'demo-certificate',
        'PSTON · ใบรับรองทดสอบ',
        true,
      ),
    );
  return all;
}
async function locked(owner: string) {
  return (
    (
      await store.get<{
        locked: boolean;
      }>('settings', owner)
    )?.locked ?? false
  );
}
async function requestOwned(id: string, owner: string) {
  z.uuid().parse(id);
  return store.transaction(async () => {
    const request = await store.get<SigningRequest>('requests', id);
    ensure(request && request.owner === owner, 404, 'REQUEST_NOT_FOUND', 'ไม่พบรายการลงนาม');
    if (request.state === 'signing' && Date.parse(request.expiresAt) + 300000 < Date.now()) {
      request.state = 'pending_review';
      request.error = 'Signing attempt expired; reconcile durable results before continuing';
      await store.put('requests', id, owner, request);
    }
    return request;
  });
}
async function manifest(request: SigningRequest) {
  return issueToken(
    'signing',
    'pston:approval-manifest',
    {
      sub: request.owner,
      purpose: 'sign',
      requestId: request.id,
      documentId: request.documentId,
      preparedHash: request.preparedHash,
      documentDigest: request.documentDigest,
      certificateId: request.certificateId,
      nonce: request.nonce,
      testOnly: request.testOnly ?? request.certificateId === 'demo-certificate',
      keyVersion: request.keyVersion,
      certificateFingerprint: request.certificateFingerprint,
    },
    Math.max(1, Math.floor((Date.parse(request.expiresAt) - Date.now()) / 1000)),
  );
}
app.get('/certificates', async (req) => ({
  certificates: await certificates(actor(req)),
  provider: {
    id: 'tdid',
    configured: !!kms,
    message: kms ? 'พร้อมนำเข้าใบรับรอง TDID จากไฟล์ P12/PFX' : 'ยังไม่ได้ตั้งค่าระบบลงนาม TDID',
  },
}));
app.post('/certificates', async (req) => {
  const owner = actor(req);
  const body = z
    .object({ pem: z.string().max(200000), label: z.string().trim().min(1).max(100) })
    .parse(req.body);
  ensure(
    !/PRIVATE KEY|PKCS12/.test(body.pem) && body.pem.includes('BEGIN CERTIFICATE'),
    400,
    'CERTIFICATE_ONLY',
    'รับเฉพาะใบรับรองสาธารณะ PEM ไม่รับ Private Key หรือ P12',
  );
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(body.pem);
  } catch {
    throw new AppError(400, 'INVALID_CERTIFICATE', 'อ่านใบรับรองไม่ได้');
  }
  const record = certificateRecord(cert, owner, randomUUID(), body.label);
  await store.transaction(async () => {
    await store.insert('certificates', record.id, owner, record);
    await store.event(owner, 'certificate.public_imported', record.id, {
      fingerprint: record.fingerprint,
      canSign: false,
    });
  });
  return record;
});
app.get('/security', async (req) => ({
  locked: await locked(actor(req)),
  provider: kms ? 'google-cloud-hsm' : mode === 'demo' ? 'demo' : 'unconfigured',
  testOnly: mode === 'demo',
  productionSigningReady:
    !!kms && (await certificates(actor(req))).some((cert) => cert.canSign && !cert.testOnly),
}));
app.post('/security/lock', async (req) => {
  const owner = actor(req);
  const { locked: next } = z.object({ locked: z.boolean() }).parse(req.body);
  ensure(
    next || mode === 'demo',
    403,
    'STEP_UP_REQUIRED',
    'การเปิดลงนามอีกครั้งต้องผ่านขั้นตอนกู้คืนและยืนยันตัวตน',
  );
  await store.transaction(async () => {
    await store.put('settings', owner, owner, { locked: next });
    await store.event(
      owner,
      next ? 'security.signing_locked' : 'security.demo_signing_unlocked',
      owner,
    );
  });
  return { locked: next };
});
app.post('/signing/prepare', async (req) => {
  const owner = actor(req);
  ensure(!(await locked(owner)), 423, 'SIGNING_LOCKED', 'การลงนามถูกระงับอยู่');
  const body = z
    .object({ previewId: z.uuid(), certificateId: z.string().max(100), idempotencyKey: z.uuid() })
    .parse(req.body);
  const fingerprint = sha256(
    canonical({ previewId: body.previewId, certificateId: body.certificateId }),
  );
  const key = sha256(owner + ':' + body.idempotencyKey);
  const previous = await store.get<{
    requestId: string;
    fingerprint: string;
  }>('idempotency', key);
  if (previous) {
    ensure(
      previous.fingerprint === fingerprint,
      409,
      'IDEMPOTENCY_CONFLICT',
      'Idempotency key is bound to a different request',
    );
    const existing = await store.get<SigningRequest>('requests', previous.requestId);
    ensure(existing, 409, 'PREPARING', 'กำลังเตรียมรายการเดิม กรุณาลองใหม่');
    return { ...existing, manifestToken: await manifest(existing) };
  }
  const cert = (await certificates(owner)).find((c) => c.id === body.certificateId);
  ensure(
    cert &&
      cert.canSign &&
      ((cert.testOnly && mode === 'demo') || (!cert.testOnly && !!kms && mode === 'google')),
    409,
    'CERTIFICATE_CANNOT_SIGN',
    'ใบรับรองนี้ยังไม่มีกุญแจหรือ Signing Provider ที่พร้อมใช้งาน',
  );
  ensure(
    Date.parse(cert.validFrom) <= Date.now() && Date.parse(cert.validTo) > Date.now(),
    409,
    'CERTIFICATE_EXPIRED',
    'ใบรับรองหมดอายุหรือยังไม่ถึงวันเริ่มใช้',
  );
  const credential = !cert.testOnly
    ? await store.get<SigningCredential>('signing_credentials', cert.id)
    : undefined;
  if (!cert.testOnly) {
    ensure(
      credential?.owner === owner && credential.enabled && kms,
      409,
      'CERTIFICATE_CANNOT_SIGN',
      'ใบรับรองไม่พร้อมลงนาม',
    );
    const trusted = await validateSigningTrust(credential.pem);
    ensure(
      sha256(trusted.cert.raw) === cert.fingerprint,
      409,
      'CERTIFICATE_MISMATCH',
      'ใบรับรองไม่ตรงกับกุญแจ',
    );
    await kms.checkVersion(credential.keyVersion, trusted.cert, credential.algorithm);
  }
  const id = randomUUID(),
    createdAt = now();
  await store.insert('idempotency', key, owner, { requestId: id, fingerprint });
  try {
    const prepared = await rpc<{
      documentId: string;
      preparedHash: string;
      documentDigest: string;
      previewHash: string;
      draftVersion: number;
      qr: boolean;
      verificationId?: string;
    }>('signing', 'documents', '/internal/prepare', {
      method: 'POST',
      actor: owner,
      body: { requestId: id, previewId: body.previewId, createdAt, certificate: cert },
    });
    const request: SigningRequest = {
      id,
      owner,
      documentId: prepared.documentId,
      certificateId: cert.id,
      previewId: body.previewId,
      previewHash: prepared.previewHash,
      preparedHash: prepared.preparedHash,
      documentDigest: prepared.documentDigest,
      draftVersion: prepared.draftVersion,
      nonce: randomBytes(32).toString('base64url'),
      createdAt,
      expiresAt: new Date(Date.now() + 300000).toISOString(),
      state: 'prepared',
      qr: prepared.qr,
      verificationId: prepared.verificationId,
      testOnly: cert.testOnly,
      keyVersion: credential?.keyVersion,
      certificateFingerprint: cert.fingerprint,
    };
    await store.transaction(async () => {
      await store.insert('requests', id, owner, request);
      await store.event(owner, 'signing.prepared', id, {
        documentId: request.documentId,
        preparedHash: request.preparedHash,
        certificateId: cert.id,
      });
    });
    return { ...request, manifestToken: await manifest(request) };
  } catch (error) {
    await store.remove('idempotency', key);
    throw error;
  }
});
async function archive(request: SigningRequest, pdf: Buffer) {
  const validation = await verifyPdf(pdf);
  ensure(
    validation.documentDigest === request.documentDigest,
    409,
    'DIGEST_MISMATCH',
    'Signed document does not match approval',
  );
  const cert = (await certificates(request.owner)).find((c) => c.id === request.certificateId);
  ensure(
    cert && validation.certificateFingerprint === cert.fingerprint,
    409,
    'CERTIFICATE_MISMATCH',
    'Signed certificate mismatch',
  );
  if (!cert.testOnly) {
    ensure(
      validation.trust === 'trusted' && validation.revocation === 'good',
      409,
      'SIGNATURE_TRUST_REJECTED',
      'ผลลงนามไม่ผ่านการตรวจใบรับรองและสถานะเพิกถอน',
    );
  }
  ensure(
    !(await locked(request.owner)),
    423,
    'SIGNING_LOCKED',
    'Signing is locked; result held for review',
  );
  const result = await rpc<{
    revision: Revision;
  }>('signing', 'documents', '/internal/archive', {
    method: 'POST',
    actor: request.owner,
    body: { requestId: request.id, pdf: pdf.toString('base64') },
  });
  request.state = 'signed';
  request.revision = result.revision;
  delete request.error;
  await store.transaction(async () => {
    await store.put('requests', request.id, request.owner, request);
    await store.event(request.owner, 'signing.completed', request.id, {
      sha256: result.revision.sha256,
      documentId: request.documentId,
      certificateId: request.certificateId,
    });
  });
  return request;
}
app.post<{
  Params: {
    id: string;
  };
}>('/signing/:id/execute', async (req) => {
  const owner = actor(req);
  let request = await requestOwned(req.params.id, owner);
  if (request.state === 'signed') return request;
  const { approvalToken } = z.object({ approvalToken: z.string().max(12000) }).parse(req.body);
  const approval = await verifyToken(approvalToken, 'pston:signing-approval', ['identity']);
  ensure(
    approval.purpose === 'sign-approval' &&
      approval.sub === owner &&
      approval.requestId === request.id &&
      approval.preparedHash === request.preparedHash &&
      approval.documentDigest === request.documentDigest &&
      approval.certificateId === request.certificateId &&
      approval.nonce === request.nonce &&
      approval.keyVersion === request.keyVersion &&
      approval.certificateFingerprint === request.certificateFingerprint,
    403,
    'APPROVAL_MISMATCH',
    'Approval does not match this document, account or certificate',
  );
  ensure(
    approval.method === 'webauthn' || (approval.method === 'demo' && mode === 'demo'),
    403,
    'APPROVAL_METHOD_REJECTED',
    'Strong approval required',
  );
  await store.transaction(async () => {
    request = await requestOwned(req.params.id, owner);
    ensure(
      request.state === 'prepared',
      409,
      'REQUEST_ALREADY_USED',
      'รายการนี้ถูกใช้แล้ว กรุณาตรวจสถานะ',
    );
    ensure(
      Date.parse(request.expiresAt) > Date.now(),
      410,
      'REQUEST_EXPIRED',
      'รายการลงนามหมดอายุ กรุณาตรวจเอกสารและอนุมัติใหม่',
    );
    ensure(!(await locked(owner)), 423, 'SIGNING_LOCKED', 'การลงนามถูกระงับ');
    request.state = 'signing';
    request.attemptId = randomUUID();
    request.approvalEvidenceHash = sha256(approvalToken);
    await store.put('requests', request.id, owner, request);
    await store.event(owner, 'signing.started', request.id, {
      preparedHash: request.preparedHash,
      approvalEvidenceHash: request.approvalEvidenceHash,
    });
  });
  let calledProvider = false;
  try {
    const prepared = await rpc<{
      pdf: string;
      preparedHash: string;
      documentDigest: string;
    }>('signing', 'documents', `/internal/prepared/${request.id}`, { actor: owner });
    const bytes = Buffer.from(prepared.pdf, 'base64');
    ensure(
      sha256(bytes) === request.preparedHash && prepared.documentDigest === request.documentDigest,
      409,
      'PREPARED_MISMATCH',
      'Prepared document was changed',
    );
    ensure(!(await locked(owner)), 423, 'SIGNING_LOCKED', 'การลงนามถูกระงับ');
    const cert = (await certificates(owner)).find((c) => c.id === request.certificateId);
    ensure(
      cert?.canSign && (cert.testOnly || approval.method === 'webauthn'),
      409,
      'CERTIFICATE_CANNOT_SIGN',
      'ใบรับรองไม่พร้อมลงนาม',
    );
    let provider;
    if (cert.testOnly) {
      ensure(mode === 'demo', 403, 'DEMO_ONLY', 'Test signing is disabled');
      provider = new DemoSigningProvider();
    } else {
      const credential = await store.get<SigningCredential>('signing_credentials', cert.id);
      ensure(
        kms &&
          credential?.owner === owner &&
          credential.enabled &&
          credential.keyVersion === request.keyVersion &&
          credential.fingerprint === request.certificateFingerprint,
        409,
        'CREDENTIAL_CHANGED',
        'กุญแจหรือใบรับรองเปลี่ยนหลังอนุมัติ กรุณาเริ่มรายการใหม่',
      );
      provider = new HsmSigningProvider(kms, credential);
    }
    calledProvider = true;
    const pdf = await provider.signPreparedPdf(bytes, new Date(request.createdAt));
    await results.write(request.id, pdf);
    return await archive(request, pdf);
  } catch (error) {
    request.state = calledProvider ? 'pending_review' : 'failed';
    request.error =
      error instanceof AppError
        ? error.message
        : 'Signing interrupted. Reconcile the stored result; do not automatically sign again.';
    await store.transaction(async () => {
      await store.put('requests', request.id, owner, request);
      await store.event(
        owner,
        'signing.interrupted',
        request.id,
        { state: request.state },
        'failure',
      );
    });
    throw error;
  }
});
app.get<{
  Params: {
    id: string;
  };
}>('/signing/:id', async (req) => await requestOwned(req.params.id, actor(req)));
app.post<{
  Params: {
    id: string;
  };
}>('/signing/:id/reconcile', async (req) => {
  const request = await requestOwned(req.params.id, actor(req));
  if (request.state === 'signed') return request;
  ensure(
    request.state === 'pending_review' ||
      (request.state === 'signing' && Date.parse(request.expiresAt) + 300000 < Date.now()),
    409,
    'NOT_RECONCILABLE',
    'Request is not waiting for review',
  );

  ensure(
    await results.exists(request.id),
    409,
    'OUTCOME_UNKNOWN',
    'ไม่พบผลลงนามที่บันทึกไว้ ต้องตรวจสอบเพิ่มเติม ระบบจะไม่สั่งลงนามซ้ำอัตโนมัติ',
  );
  return archive(request, await results.read(request.id));
});
await listen(app, 'signing', 3003);
