import { GoogleAuth } from 'google-auth-library';
import { createHash, createPublicKey, verify, X509Certificate } from 'node:crypto';
import { AppError, ensure } from '../../../packages/core/src/errors.js';

export function crc32c(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0x82f63b78 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
export interface KmsVersion {
  name: string;
  state: string;
  algorithm: string;
  protectionLevel: string;
}
export interface ImportJob {
  name: string;
  state: string;
  expireTime?: string;
  importMethod: string;
  protectionLevel: string;
  publicKey?: { pem: string };
}
export type KmsTransport = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
async function googleRequest<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const token = await auth.getAccessToken();
  let response: Response;
  try {
    // No automatic retries of signing or key imports: outcomes may be uncertain.
    response = await fetch(`https://cloudkms.googleapis.com/v1/${path}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new AppError(503, 'KMS_UNAVAILABLE', 'Cloud HSM request interrupted');
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new AppError(503, 'KMS_REJECTED', `Cloud HSM returned HTTP ${response.status}`);
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new AppError(503, 'KMS_RESPONSE_INVALID', 'Cloud HSM returned invalid JSON');
  }
}
export class CloudHsm {
  constructor(
    readonly keyRing: string,
    private request: KmsTransport = googleRequest,
  ) {
    if (
      !/^projects\/[a-z][a-z0-9-]+\/locations\/[a-z0-9-]+\/keyRings\/[a-zA-Z0-9_-]+$/.test(keyRing)
    )
      throw new Error('Invalid PSTON_KMS_KEY_RING');
  }
  private version(name: string) {
    ensure(
      name.startsWith(`${this.keyRing}/cryptoKeys/`) &&
        /^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[a-zA-Z0-9_-]+\/cryptoKeyVersions\/[1-9]\d*$/.test(
          name,
        ),
      409,
      'KMS_VERSION_REJECTED',
      'Key version is outside the configured key ring',
    );
    return name;
  }
  async createImportJob(id: string) {
    ensure(/^[a-z0-9-]{1,63}$/.test(id), 400, 'INVALID_IMPORT_ID', 'Invalid import ID');
    return this.request<ImportJob>(`${this.keyRing}/importJobs?importJobId=${id}`, 'POST', {
      importMethod: 'RSA_OAEP_3072_SHA256_AES_256',
      protectionLevel: 'HSM',
    });
  }
  async getImportJob(id: string) {
    ensure(/^[a-z0-9-]{1,63}$/.test(id), 400, 'INVALID_IMPORT_ID', 'Invalid import ID');
    const job = await this.request<ImportJob>(`${this.keyRing}/importJobs/${id}`);
    ensure(
      job.name === `${this.keyRing}/importJobs/${id}` &&
        job.protectionLevel === 'HSM' &&
        job.importMethod === 'RSA_OAEP_3072_SHA256_AES_256',
      409,
      'IMPORT_JOB_REJECTED',
      'Invalid import job',
    );
    return job;
  }
  async createKey(id: string, algorithm: string) {
    ensure(
      /^[a-z0-9-]{1,63}$/.test(id) && /^RSA_SIGN_PKCS1_(2048|3072|4096)_SHA256$/.test(algorithm),
      400,
      'INVALID_KEY',
      'Invalid key settings',
    );
    return this.request<{ name: string }>(
      `${this.keyRing}/cryptoKeys?cryptoKeyId=${id}&skipInitialVersionCreation=true`,
      'POST',
      {
        purpose: 'ASYMMETRIC_SIGN',
        importOnly: true,
        versionTemplate: { algorithm, protectionLevel: 'HSM' },
      },
    );
  }
  async importKey(id: string, jobId: string, algorithm: string, wrappedKey: string) {
    ensure(
      /^[a-z0-9-]{1,63}$/.test(id) &&
        /^[a-z0-9-]{1,63}$/.test(jobId) &&
        /^RSA_SIGN_PKCS1_(2048|3072|4096)_SHA256$/.test(algorithm),
      400,
      'INVALID_IMPORT',
      'Invalid key import',
    );
    return this.request<KmsVersion>(
      `${this.keyRing}/cryptoKeys/${id}/cryptoKeyVersions:import`,
      'POST',
      {
        importJob: `${this.keyRing}/importJobs/${jobId}`,
        algorithm,
        wrappedKey,
      },
    );
  }
  async listVersions(id: string) {
    ensure(/^[a-z0-9-]{1,63}$/.test(id), 400, 'INVALID_KEY', 'Invalid key');
    return this.request<{ cryptoKeyVersions?: KmsVersion[] }>(
      `${this.keyRing}/cryptoKeys/${id}/cryptoKeyVersions?pageSize=10`,
    );
  }
  async checkVersion(name: string, cert: X509Certificate, algorithm: string) {
    const version = await this.request<KmsVersion>(this.version(name));
    ensure(
      version.name === name &&
        version.state === 'ENABLED' &&
        version.protectionLevel === 'HSM' &&
        version.algorithm === algorithm,
      409,
      'KEY_NOT_READY',
      'กุญแจ HSM ยังไม่พร้อมหรือถูกระงับ',
    );
    const key = await this.request<{
      name: string;
      pem: string;
      pemCrc32c: string;
      algorithm: string;
      protectionLevel: string;
    }>(`${name}/publicKey`);
    ensure(
      key.name === name &&
        key.algorithm === algorithm &&
        key.protectionLevel === 'HSM' &&
        String(crc32c(Buffer.from(key.pem))) === String(key.pemCrc32c) &&
        createPublicKey(key.pem)
          .export({ format: 'der', type: 'spki' })
          .equals(cert.publicKey.export({ format: 'der', type: 'spki' })),
      409,
      'CERTIFICATE_KEY_MISMATCH',
      'กุญแจใน HSM ไม่ตรงกับใบรับรอง',
    );
    return version;
  }
  async sign(name: string, data: Buffer, cert: X509Certificate, algorithm: string) {
    await this.checkVersion(name, cert, algorithm);
    const digest = createHash('sha256').update(data).digest();
    const result = await this.request<{
      name: string;
      signature: string;
      signatureCrc32c: string;
      verifiedDigestCrc32c: boolean;
      protectionLevel: string;
    }>(`${this.version(name)}:asymmetricSign`, 'POST', {
      digest: { sha256: digest.toString('base64') },
      digestCrc32c: String(crc32c(digest)),
    });
    const signature = Buffer.from(result.signature ?? '', 'base64');
    ensure(
      result.name === name &&
        result.protectionLevel === 'HSM' &&
        result.verifiedDigestCrc32c === true &&
        String(crc32c(signature)) === String(result.signatureCrc32c) &&
        verify('sha256', data, cert.publicKey, signature),
      409,
      'SIGNATURE_INTEGRITY_FAILURE',
      'ผลลงนามจาก HSM ไม่ผ่านการตรวจสอบ',
    );
    return signature;
  }
}
