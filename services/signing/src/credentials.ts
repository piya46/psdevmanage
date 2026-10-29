import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { actor } from '../../../packages/core/src/http.js';
import { Store } from '../../../packages/core/src/store.js';
import { ensure } from '../../../packages/core/src/errors.js';
import { sha256 } from '../../../packages/core/src/security.js';
import type { CertificateProfile } from '../../../packages/core/src/types.js';
import { validateSigningTrust } from '../../../packages/core/src/certificate-trust.js';
import { CloudHsm } from './kms.js';

export interface SigningCredential {
  id: string;
  owner: string;
  pem: string;
  keyVersion: string;
  algorithm: string;
  fingerprint: string;
  enabled: boolean;
}
interface ImportRecord {
  id: string;
  owner: string;
  pem: string;
  label: string;
  algorithm: string;
  fingerprint: string;
  keyId: string;
  jobId: string;
  createdAt: string;
  state: 'preparing' | 'wrapping' | 'importing' | 'ready' | 'failed';
  keyVersion?: string;
}
export class CredentialImports {
  constructor(
    private store: Store,
    private kms: CloudHsm,
    private trust: typeof validateSigningTrust = validateSigningTrust,
  ) {}
  async pending(owner: string) {
    return (await this.store.list<ImportRecord>('key_imports', owner))
      .filter((record) => record.state === 'importing')
      .map(({ id, label, createdAt }) => ({ id, label, createdAt }));
  }
  async start(owner: string, body: { pem: string; label: string; idempotencyKey: string }) {
    const trusted = await this.trust(body.pem);
    const fingerprint = sha256(trusted.cert.raw);
    let record: ImportRecord;
    const existing = await this.store.get<ImportRecord>('key_imports', body.idempotencyKey);
    if (existing) {
      ensure(
        existing.owner === owner && existing.fingerprint === fingerprint,
        409,
        'IMPORT_CONFLICT',
        'รายการนำเข้าไม่ตรงกับบัญชีหรือใบรับรอง',
      );
      return { id: existing.id, state: existing.state };
    }
    await this.store.transaction(async () => {
      const imports = await this.store.list<ImportRecord>('key_imports', owner);
      ensure(
        imports.filter((i) => Date.now() - Date.parse(i.createdAt) < 3600000).length < 5,
        429,
        'IMPORT_LIMIT',
        'นำเข้าได้ไม่เกิน 5 ครั้งต่อชั่วโมง',
      );
      ensure(
        (await this.store.list<SigningCredential>('signing_credentials', owner)).length < 10,
        409,
        'CERTIFICATE_LIMIT',
        'เก็บใบรับรองสำหรับลงนามได้ไม่เกิน 10 ใบ',
      );
      const id = body.idempotencyKey;
      record = {
        id,
        owner,
        label: body.label,
        pem: trusted.cert.toString(),
        algorithm: trusted.algorithm,
        fingerprint,
        keyId: `c-${randomUUID()}`,
        jobId: `i-${randomUUID()}`,
        createdAt: new Date().toISOString(),
        state: 'preparing',
      };
      await this.store.insert('key_imports', id, owner, record);
      await this.store.event(owner, 'certificate.import_started', id, { fingerprint });
    });
    try {
      await this.kms.createKey(record!.keyId, record!.algorithm);
      await this.kms.createImportJob(record!.jobId);
      record!.state = 'wrapping';
      await this.store.put('key_imports', record!.id, owner, record!);
      return { id: record!.id, state: record!.state };
    } catch (error) {
      record!.state = 'failed';
      await this.store.put('key_imports', record!.id, owner, record!);
      throw error;
    }
  }
  private async owned(owner: string, id: string) {
    const record = await this.store.get<ImportRecord>('key_imports', id);
    ensure(record?.owner === owner, 404, 'IMPORT_NOT_FOUND', 'ไม่พบรายการนำเข้า');
    return record;
  }
  async status(owner: string, id: string) {
    const record = await this.owned(owner, id);
    if (record.state === 'wrapping') {
      ensure(
        Date.now() - Date.parse(record.createdAt) < 600000,
        410,
        'IMPORT_EXPIRED',
        'รายการนำเข้าหมดอายุ กรุณาเริ่มใหม่',
      );
      const job = await this.kms.getImportJob(record.jobId);
      return {
        id,
        state: record.state,
        publicKey: job.state === 'ACTIVE' ? job.publicKey?.pem : undefined,
      };
    }
    if (record.state === 'importing') {
      // A timed-out import is reconciled by listing versions, never importing again.
      const versions = (await this.kms.listVersions(record.keyId)).cryptoKeyVersions ?? [];
      ensure(
        versions.length <= 1,
        409,
        'IMPORT_AMBIGUOUS',
        'พบกุญแจหลายเวอร์ชัน ต้องตรวจสอบก่อนเปิดใช้งาน',
      );
      const version = versions[0];
      if (version?.state === 'IMPORT_FAILED') {
        record.state = 'failed';
        await this.store.put('key_imports', id, owner, record);
        return { id, state: record.state };
      }
      if (version?.state === 'ENABLED') {
        const trusted = await this.trust(record.pem);
        await this.kms.checkVersion(version.name, trusted.cert, record.algorithm);
        const credential: SigningCredential = {
          id,
          owner,
          pem: record.pem,
          keyVersion: version.name,
          algorithm: record.algorithm,
          fingerprint: record.fingerprint,
          enabled: true,
        };
        const cert = trusted.cert;
        const profile: CertificateProfile = {
          id,
          owner,
          label: record.label,
          subject: cert.subject,
          issuer: cert.issuer,
          serial: cert.serialNumber,
          fingerprint: record.fingerprint,
          validFrom: new Date(cert.validFrom).toISOString(),
          validTo: new Date(cert.validTo).toISOString(),
          algorithm: 'rsa',
          provider: 'tdid',
          canSign: true,
          testOnly: false,
        };
        await this.store.transaction(async () => {
          const current = await this.owned(owner, id);
          if (current.state === 'ready') {
            record.state = 'ready';
            return;
          }
          ensure(
            current.state === 'importing',
            409,
            'IMPORT_STATE_CHANGED',
            'สถานะนำเข้าเปลี่ยนแล้ว',
          );
          record.state = 'ready';
          record.keyVersion = version.name;
          await this.store.put('signing_credentials', id, owner, credential);
          await this.store.put('certificates', id, owner, profile);
          await this.store.put('key_imports', id, owner, record);
          await this.store.event(owner, 'certificate.hsm_imported', id, {
            fingerprint: record.fingerprint,
            keyVersion: version.name,
          });
        });
      }
    }
    return { id, state: record.state };
  }
  async complete(owner: string, id: string, wrappedKey: string) {
    let record = await this.owned(owner, id);
    if (record.state === 'ready' || record.state === 'importing')
      return { id, state: record.state };
    ensure(
      record.state === 'wrapping' && Date.now() - Date.parse(record.createdAt) < 600000,
      409,
      'IMPORT_NOT_READY',
      'รายการนำเข้าไม่พร้อมหรือหมดอายุ',
    );
    const wrapped = Buffer.from(wrappedKey, 'base64');
    ensure(
      wrapped.toString('base64') === wrappedKey && wrapped.length >= 512 && wrapped.length <= 4096,
      400,
      'INVALID_WRAPPED_KEY',
      'รูปแบบกุญแจที่เข้ารหัสไม่ถูกต้อง',
    );
    const job = await this.kms.getImportJob(record.jobId);
    ensure(job.state === 'ACTIVE', 409, 'IMPORT_JOB_NOT_READY', 'HSM ยังเตรียมการนำเข้าไม่เสร็จ');
    await this.store.transaction(async () => {
      record = await this.owned(owner, id);
      ensure(record.state === 'wrapping', 409, 'IMPORT_ALREADY_USED', 'รายการนำเข้านี้ถูกใช้แล้ว');
      record.state = 'importing';
      await this.store.put('key_imports', id, owner, record);
      await this.store.event(owner, 'certificate.import_submitted', id, {
        fingerprint: record.fingerprint,
      });
    });
    // Persist no encrypted P12, password, plaintext key or wrapped payload.
    await this.kms.importKey(record.keyId, record.jobId, record.algorithm, wrappedKey);
    return { id, state: record.state };
  }
}
export function registerCertificateImports(app: FastifyInstance, imports: CredentialImports) {
  app.get('/certificates/imports', async (req) => ({ imports: await imports.pending(actor(req)) }));
  app.post('/certificates/imports', { bodyLimit: 50000 }, async (req) => {
    const body = z
      .object({
        pem: z.string().max(20000),
        label: z.string().trim().min(1).max(100),
        idempotencyKey: z.uuid(),
        policyAccepted: z.literal(true),
      })
      .strict()
      .parse(req.body);
    return imports.start(actor(req), body);
  });
  app.get<{ Params: { id: string } }>('/certificates/imports/:id', async (req) =>
    imports.status(actor(req), z.uuid().parse(req.params.id)),
  );
  app.post<{ Params: { id: string } }>(
    '/certificates/imports/:id',
    { bodyLimit: 12000 },
    async (req) => {
      const body = z
        .object({ wrappedKey: z.string().max(6000) })
        .strict()
        .parse(req.body);
      return imports.complete(actor(req), z.uuid().parse(req.params.id), body.wrappedKey);
    },
  );
}
