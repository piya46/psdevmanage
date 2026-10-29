import { X509Certificate } from 'node:crypto';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import forge from 'node-forge';
import { ensure, AppError } from './errors.js';

const openssl = promisify(execFile);
export interface TrustBundle {
  root: { pem: string };
  issuer: { pem: string };
}
export const tdidCRLURLs = [
  'https://www.nrca.go.th/crl/THNRCA_arlfile.crl',
  'https://www.thaidigitalid.com/tdidcag3crl/certdist?cmd=crl&issuer=CN%3DThai+Digital+ID+CA+G3%2CO%3DThai+Digital+ID+Company+Limited%2CC%3DTH',
];
export async function tdidTrustBundle(): Promise<TrustBundle> {
  return JSON.parse(await readFile(join(process.cwd(), 'assets/trust/tdid-g3.json'), 'utf8'));
}
export function signingCertificate(pem: string, at = new Date()) {
  ensure(
    !/PRIVATE KEY/.test(pem) && (pem.match(/BEGIN CERTIFICATE/g) ?? []).length === 1,
    400,
    'CERTIFICATE_ONLY',
    'ต้องเป็นใบรับรองสาธารณะหนึ่งใบ',
  );
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(pem);
  } catch {
    throw new AppError(400, 'INVALID_CERTIFICATE', 'อ่านใบรับรองไม่ได้');
  }
  ensure(!cert.ca, 400, 'CA_CERTIFICATE', 'ไม่สามารถใช้ใบรับรอง CA ลงนามเอกสาร');
  ensure(
    new Date(cert.validFrom) <= at && at < new Date(cert.validTo),
    409,
    'CERTIFICATE_EXPIRED',
    'ใบรับรองหมดอายุหรือยังไม่ถึงวันเริ่มใช้',
  );
  const key = cert.publicKey;
  const bits = key.asymmetricKeyDetails?.modulusLength;
  ensure(
    key.asymmetricKeyType === 'rsa' &&
      bits &&
      [2048, 3072, 4096].includes(bits) &&
      key.asymmetricKeyDetails?.publicExponent === 65537n,
    400,
    'UNSUPPORTED_KEY',
    'รองรับกุญแจ RSA 2048, 3072 หรือ 4096 บิต',
  );
  const parsed = forge.pki.certificateFromPem(cert.toString());
  const usage = parsed.getExtension('keyUsage') as {
    digitalSignature?: boolean;
    nonRepudiation?: boolean;
  } | null;
  ensure(
    usage && (usage.digitalSignature || usage.nonRepudiation),
    400,
    'KEY_USAGE_REJECTED',
    'ใบรับรองนี้ไม่อนุญาตการลงนามดิจิทัล',
  );
  const eku = parsed.getExtension('extKeyUsage') as Record<string, unknown> | null;
  // Reject certificates restricted to TLS/code signing. TDID personal certificates
  // also use emailProtection; unrestricted EKU is allowed with signing KeyUsage.
  ensure(
    !eku ||
      eku.emailProtection ||
      eku['1.3.6.1.5.5.7.3.36'] ||
      eku['1.3.6.1.4.1.311.10.3.12'] ||
      eku['1.2.840.113583.1.1.5'],
    400,
    'EXTENDED_KEY_USAGE_REJECTED',
    'ประเภทใบรับรองไม่รองรับการลงนามเอกสาร',
  );
  return { cert, algorithm: `RSA_SIGN_PKCS1_${bits}_SHA256` };
}

let cached: { at: number; crls: Buffer[] } | undefined;
async function downloadCRLs() {
  if (cached && Date.now() - cached.at < 300000) return cached.crls;
  const crls = await Promise.all(
    tdidCRLURLs.map(async (url) => {
      // Fixed CA endpoints only: never follow an AIA/CDP URL supplied by an uploader.
      const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15000) });
      if (!res.ok || !res.body) throw new Error('CRL unavailable');
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of res.body) {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) throw new Error('CRL too large');
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    }),
  );
  cached = { at: Date.now(), crls };
  return crls;
}

/** Trust is pinned to the production TDID G3 / NRCA G1 chain, never an uploaded root. */
export async function validateSigningTrust(
  pem: string,
  { bundle, crls, at = new Date() }: { bundle?: TrustBundle; crls?: Buffer[]; at?: Date } = {},
) {
  const { cert, algorithm } = signingCertificate(pem, at);
  const trust = bundle ?? (await tdidTrustBundle());
  const issuer = new X509Certificate(trust.issuer.pem);
  const root = new X509Certificate(trust.root.pem);
  ensure(
    cert.checkIssued(issuer) &&
      cert.verify(issuer.publicKey) &&
      issuer.checkIssued(root) &&
      issuer.verify(root.publicKey),
    400,
    'UNTRUSTED_CERTIFICATE',
    'รองรับใบรับรองที่ออกโดย TDID CA G3 เท่านั้น',
  );
  const dir = await mkdtemp(join(tmpdir(), 'pston-trust-'));
  try {
    let revocations: Buffer[];
    try {
      revocations = crls ?? (await downloadCRLs());
    } catch {
      throw new AppError(
        409,
        'REVOCATION_UNAVAILABLE',
        'ตรวจสถานะเพิกถอนไม่ได้ กรุณาลองใหม่ภายหลัง',
      );
    }
    const crlPEMs: string[] = [];
    for (let i = 0; i < revocations.length; i++) {
      const path = join(dir, `${i}.crl`);
      await writeFile(path, revocations[i], { mode: 0o600 });
      const { stdout } = await openssl(
        'openssl',
        [
          'crl',
          '-inform',
          revocations[i].toString('ascii', 0, 10).startsWith('-----BEGIN') ? 'PEM' : 'DER',
          '-in',
          path,
          '-outform',
          'PEM',
        ],
        { timeout: 10000, maxBuffer: 16 * 1024 * 1024 },
      );
      crlPEMs.push(stdout);
    }
    await Promise.all([
      writeFile(join(dir, 'leaf.pem'), cert.toString(), { mode: 0o600 }),
      writeFile(join(dir, 'root.pem'), trust.root.pem, { mode: 0o600 }),
      writeFile(join(dir, 'issuer.pem'), trust.issuer.pem, { mode: 0o600 }),
      writeFile(join(dir, 'crls.pem'), crlPEMs.join('\n'), { mode: 0o600 }),
    ]);
    // OpenSSL checks CRL signatures, issuer scope, last/nextUpdate and revocation
    // for both the leaf and its issuer, even when CRL bytes came from the cache.
    await openssl(
      'openssl',
      [
        'verify',
        '-CAfile',
        join(dir, 'root.pem'),
        '-no-CApath',
        '-untrusted',
        join(dir, 'issuer.pem'),
        '-purpose',
        'any',
        '-auth_level',
        '2',
        '-attime',
        String(Math.floor(at.getTime() / 1000)),
        '-crl_check_all',
        '-CRLfile',
        join(dir, 'crls.pem'),
        join(dir, 'leaf.pem'),
      ],
      { timeout: 15000, maxBuffer: 16384 },
    );
    return {
      cert,
      algorithm,
      chain: [cert.toString(), trust.issuer.pem],
      trust: 'trusted' as const,
      revocation: 'good' as const,
      checkedAt: at.toISOString(),
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      409,
      'CERTIFICATE_TRUST_REJECTED',
      'ใบรับรองหรือรายการเพิกถอนไม่ผ่านการตรวจสอบ ระบบยังไม่อนุญาตให้ลงนาม',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
