import { beforeAll, afterAll, it, expect } from 'vitest';
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  privateDecrypt,
  constants,
  createDecipheriv,
  X509Certificate,
  randomUUID,
} from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { pdflibAddPlaceholder } from '@signpdf/placeholder-pdf-lib';
import { SignPdf } from '@signpdf/signpdf';
import { Signer } from '@signpdf/utils';
import { P12Session } from '../../apps/web/src/p12.js';
import {
  validateSigningTrust,
  signingCertificate,
} from '../../packages/core/src/certificate-trust.js';
import { createDetachedCms } from '../../services/signing/src/cms.js';
import { CloudHsm, crc32c, type KmsTransport } from '../../services/signing/src/kms.js';
import { CredentialImports } from '../../services/signing/src/credentials.js';
import { Store } from '../../packages/core/src/store.js';
import { extractSignature, verifyPdf } from '../../packages/core/src/pdf-signature.js';
import { signingFixture } from '../fixtures/signing.js';

let fixture: ReturnType<typeof signingFixture>;
beforeAll(() => {
  fixture = signingFixture();
});
afterAll(() => fixture.cleanup());
const keyRing = 'projects/pston-test/locations/asia-southeast1/keyRings/test';
const algorithm = 'RSA_SIGN_PKCS1_2048_SHA256';

it('reads encrypted P12 and wraps PKCS8 in browser-compatible code; OpenSSL unwraps identical private key', async () => {
  const data = Uint8Array.from(fixture.p12).buffer;
  expect(() => new P12Session(data, 'wrong')).toThrow('รหัสผ่าน');
  expect(() => new P12Session(data, 'fixture-only-password', new Date('2100-01-01'))).toThrow(
    'หมดอายุ',
  );
  const p12 = new P12Session(data, 'fixture-only-password');
  expect(p12.metadata.algorithm).toBe(algorithm);
  const wrapping = generateKeyPairSync('rsa', { modulusLength: 3072 });
  const payload = Buffer.from(
    await p12.wrap(wrapping.publicKey.export({ type: 'spki', format: 'pem' }).toString()),
    'base64',
  );
  const kek = privateDecrypt(
    { key: wrapping.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    payload.subarray(0, 384),
  );
  const decipher = createDecipheriv('id-aes256-wrap-pad', kek, Buffer.from('a65959a6', 'hex'));
  const decoded = Buffer.concat([decipher.update(payload.subarray(384)), decipher.final()]);
  expect(
    createPublicKey(createPrivateKey({ key: decoded, format: 'der', type: 'pkcs8' })).export({
      type: 'spki',
      format: 'der',
    }),
  ).toEqual(new X509Certificate(fixture.pem).publicKey.export({ type: 'spki', format: 'der' }));
  expect(JSON.stringify(p12.metadata)).not.toMatch(/PRIVATE KEY|fixture-only-password/);
  await expect(p12.wrap('')).rejects.toThrow('ถูกใช้แล้ว');
});

it('validates chain and both CRLs, rejecting revoked, expired, CA and untrusted certificates', async () => {
  const crls = fixture.crls();
  await expect(
    validateSigningTrust(fixture.pem, { bundle: fixture.bundle, crls }),
  ).resolves.toMatchObject({ trust: 'trusted', revocation: 'good' });
  expect(() => signingCertificate(fixture.bundle.root.pem)).toThrow('CA');
  await expect(
    validateSigningTrust(fixture.pem, { bundle: fixture.bundle, crls, at: new Date('2100-01-01') }),
  ).rejects.toThrow('หมดอายุ');
  await expect(
    validateSigningTrust(fixture.pem, {
      bundle: { ...fixture.bundle, issuer: fixture.bundle.root },
      crls,
    }),
  ).rejects.toThrow('TDID');
  await expect(
    validateSigningTrust(fixture.pem, { bundle: fixture.bundle, crls: [] }),
  ).rejects.toThrow('ไม่ผ่าน');
});

function mockKms(options: { badCrc?: boolean; mismatch?: boolean; disabled?: boolean } = {}) {
  const cert = new X509Certificate(fixture.pem);
  const publicPem = cert.publicKey.export({ format: 'pem', type: 'spki' }).toString();
  let calls = 0;
  const request: KmsTransport = async <T>(path: string, _method?: string, body?: unknown) => {
    if (path.endsWith(':asymmetricSign')) {
      calls++;
      const input = body as { digest: { sha256: string }; digestCrc32c: string };
      const digest = Buffer.from(input.digest.sha256, 'base64');
      expect(input.digestCrc32c).toBe(String(crc32c(digest)));
      // Node's raw RSA signing is expressed with a DigestInfo for the prehashed KMS input.
      const { privateEncrypt } = await import('node:crypto');
      const signature = privateEncrypt(
        { key: fixture.key, padding: constants.RSA_PKCS1_PADDING },
        Buffer.concat([Buffer.from('3031300d060960864801650304020105000420', 'hex'), digest]),
      );
      return {
        name: path.replace(':asymmetricSign', ''),
        signature: signature.toString('base64'),
        signatureCrc32c: String(crc32c(signature) + (options.badCrc ? 1 : 0)),
        verifiedDigestCrc32c: true,
        protectionLevel: 'HSM',
      } as T;
    }
    if (path.endsWith('/publicKey'))
      return {
        name: path.replace('/publicKey', ''),
        pem: publicPem,
        pemCrc32c: String(crc32c(Buffer.from(publicPem))),
        algorithm,
        protectionLevel: 'HSM',
      } as T;
    return {
      name: options.mismatch ? path + '-wrong' : path,
      state: options.disabled ? 'DISABLED' : 'ENABLED',
      algorithm,
      protectionLevel: 'HSM',
    } as T;
  };
  return { kms: new CloudHsm(keyRing, request), calls: () => calls };
}

it('signs a real PDF through KMS digest contract and independently validates CMS/CAdES with OpenSSL', async () => {
  const { kms, calls } = mockKms();
  const doc = await PDFDocument.create();
  doc.addPage();
  pdflibAddPlaceholder({
    pdfDoc: doc,
    reason: 'Fixture only',
    name: 'Fixture',
    contactInfo: '',
    location: '',
    signatureLength: 16000,
  });
  const input = Buffer.from(await doc.save({ useObjectStreams: false }));
  class FixtureSigner extends Signer {
    async sign(content: Buffer) {
      return createDetachedCms(
        content,
        [fixture.pem, fixture.bundle.issuer.pem],
        new Date(),
        (attrs) =>
          kms.sign(
            `${keyRing}/cryptoKeys/test/cryptoKeyVersions/1`,
            attrs,
            new X509Certificate(fixture.pem),
            algorithm,
          ),
      );
    }
  }
  const pdf = await new SignPdf().sign(input, new FixtureSigner());
  expect(calls()).toBe(1);
  expect(await verifyPdf(pdf)).toMatchObject({
    crypto: 'valid',
    trust: 'untrusted',
    timestamp: 'none',
  });
  const extracted = extractSignature(pdf);
  writeFileSync(fixture.path('content.bin'), extracted.content);
  writeFileSync(fixture.path('cms.der'), extracted.cms);
  fixture.openssl([
    'cms',
    '-verify',
    '-cades',
    '-binary',
    '-inform',
    'DER',
    '-in',
    'cms.der',
    '-content',
    'content.bin',
    '-CAfile',
    'root.pem',
    '-purpose',
    'any',
    '-out',
    'verified.bin',
  ]);
  const altered = Buffer.from(pdf);
  altered[20] ^= 1;
  await expect(verifyPdf(altered)).rejects.toThrow();
});

it('rejects wrong KMS resources, disabled versions, and signature corruption without retries', async () => {
  expect(crc32c(Buffer.from('123456789'))).toBe(0xe3069283);
  const version = `${keyRing}/cryptoKeys/test/cryptoKeyVersions/1`;
  for (const options of [{ badCrc: true }, { mismatch: true }, { disabled: true }]) {
    const { kms, calls } = mockKms(options);
    await expect(
      kms.sign(
        version,
        Buffer.from('approved attributes'),
        new X509Certificate(fixture.pem),
        algorithm,
      ),
    ).rejects.toThrow();
    expect(calls()).toBeLessThanOrEqual(1);
  }
  await expect(
    mockKms().kms.sign(
      version.replace('pston-test', 'other-project'),
      Buffer.from('data'),
      new X509Certificate(fixture.pem),
      algorithm,
    ),
  ).rejects.toThrow('outside');
});

it('keeps imports owner-bound, consumes wrapped submission once and reconciles an uncertain KMS response', async () => {
  const store = await Store.open('signing', ':memory:');
  let keyId = '',
    jobId = '',
    imported = false,
    importCalls = 0;
  const good = mockKms();
  const transport: KmsTransport = async <T>(path: string, method?: string) => {
    if (path.includes('cryptoKeyId=')) {
      keyId = new URL('https://example.test/' + path).searchParams.get('cryptoKeyId')!;
      return {} as T;
    }
    if (path.includes('importJobId=')) {
      jobId = new URL('https://example.test/' + path).searchParams.get('importJobId')!;
      return {} as T;
    }
    if (path.includes('/importJobs/'))
      return {
        name: `${keyRing}/importJobs/${jobId}`,
        state: 'ACTIVE',
        protectionLevel: 'HSM',
        importMethod: 'RSA_OAEP_3072_SHA256_AES_256',
        publicKey: { pem: 'public-only' },
      } as T;
    if (path.endsWith(':import')) {
      importCalls++;
      imported = true;
      throw new Error('Network response lost');
    }
    if (method === undefined && path.includes('pageSize='))
      return {
        cryptoKeyVersions: imported
          ? [
              {
                name: `${keyRing}/cryptoKeys/${keyId}/cryptoKeyVersions/1`,
                state: 'ENABLED',
                algorithm,
                protectionLevel: 'HSM',
              },
            ]
          : [],
      } as T;
    throw new Error('Unexpected KMS request');
  };
  const kms = new CloudHsm(keyRing, transport);
  kms.checkVersion = good.kms.checkVersion.bind(good.kms);
  const crls = fixture.crls();
  const imports = new CredentialImports(store, kms, (pem) =>
    validateSigningTrust(pem, { bundle: fixture.bundle, crls }),
  );
  const id = randomUUID();
  try {
    const input = { idempotencyKey: id, label: 'Fixture', pem: fixture.pem };
    await imports.start('owner-a', input);
    await expect(imports.status('owner-b', id)).rejects.toThrow('ไม่พบ');
    await expect(imports.start('owner-b', input)).rejects.toThrow('ไม่ตรง');
    await expect(
      imports.complete('owner-a', id, Buffer.alloc(1600).toString('base64')),
    ).rejects.toThrow('response lost');
    await imports.complete('owner-a', id, Buffer.alloc(1600).toString('base64'));
    expect(importCalls).toBe(1);
    await expect(imports.status('owner-a', id)).resolves.toMatchObject({ state: 'ready' });
    expect(await store.list('signing_credentials', 'owner-b')).toHaveLength(0);
    expect(await store.list('certificates', 'owner-a')).toMatchObject([
      { canSign: true, testOnly: false },
    ]);
    expect(JSON.stringify(await store.list('key_imports', 'owner-a'))).not.toMatch(
      /PRIVATE KEY|wrappedKey|password/,
    );
  } finally {
    await store.close();
  }
});

it('refuses a revoked signing certificate even when an earlier CRL allowed it', async () => {
  fixture.openssl(['ca', '-config', 'issuer.cnf', '-revoke', 'leaf.pem']);
  await expect(
    validateSigningTrust(fixture.pem, { bundle: fixture.bundle, crls: fixture.crls() }),
  ).rejects.toThrow('ไม่ผ่าน');
});
