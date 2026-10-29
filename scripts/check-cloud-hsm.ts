/** Operator-only Cloud Run job: verifies real HSM APIs using a freshly generated fixture key. */
import { generateKeyPairSync, randomUUID, X509Certificate, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import forge from 'node-forge';
import { PDFDocument } from 'pdf-lib';
import { pdflibAddPlaceholder } from '@signpdf/placeholder-pdf-lib';
import { SignPdf } from '@signpdf/signpdf';
import { Signer, SUBFILTER_ETSI_CADES_DETACHED } from '@signpdf/utils';
import { P12Session } from '../apps/web/src/p12.js';
import { CloudHsm } from '../services/signing/src/kms.js';
import { createDetachedCms } from '../services/signing/src/cms.js';
import { extractSignature } from '../packages/core/src/pdf-signature.js';
import { tdidTrustBundle, tdidCRLURLs } from '../packages/core/src/certificate-trust.js';

const kms = new CloudHsm(process.env.PSTON_KMS_KEY_RING ?? '');
const id = process.env.PSTON_HSM_PROBE_ID;
if (!id || !/^probe-[a-z0-9-]{1,50}$/.test(id)) throw new Error('Set a unique PSTON_HSM_PROBE_ID');
const dir = mkdtempSync(join(tmpdir(), 'pston-hsm-probe-'));
const wait = () => new Promise((resolve) => setTimeout(resolve, 3000));
const openssl = (args: string[]) =>
  execFileSync('openssl', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 });
try {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKey = forge.pki.privateKeyFromPem(
    key.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  );
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(
    key.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  );
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 60000);
  cert.validity.notAfter = new Date(Date.now() + 86400000);
  cert.setSubject([{ name: 'commonName', value: 'PSTON EPHEMERAL HSM PROBE ONLY' }]);
  cert.setIssuer(cert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true },
  ]);
  cert.sign(privateKey, forge.md.sha256.create());
  const pem = forge.pki.certificateToPem(cert);
  const password = randomUUID();
  const p12 = forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(privateKey, cert, password)).getBytes();
  const session = new P12Session(Uint8Array.from(p12, (c) => c.charCodeAt(0)).buffer, password);
  const algorithm = 'RSA_SIGN_PKCS1_2048_SHA256';
  await kms.createKey(id, algorithm);
  await kms.createImportJob(id);
  console.log(JSON.stringify({ probe: id, stage: 'waiting_for_import_job' }));
  let publicKey: string | undefined;
  for (let i = 0; i < 100; i++) {
    const job = await kms.getImportJob(id);
    if (job.state === 'ACTIVE') {
      publicKey = job.publicKey?.pem;
      break;
    }
    await wait();
  }
  if (!publicKey) throw new Error('Import job did not become active');
  const imported = await kms.importKey(id, id, algorithm, await session.wrap(publicKey));
  console.log(JSON.stringify({ probe: id, stage: 'waiting_for_key', keyVersion: imported.name }));
  let enabled = false;
  for (let i = 0; i < 100; i++) {
    const versions = (await kms.listVersions(id)).cryptoKeyVersions ?? [];
    if (versions.some((v) => v.state === 'IMPORT_FAILED')) throw new Error('HSM import failed');
    if (versions.some((v) => v.name === imported.name && v.state === 'ENABLED')) {
      enabled = true;
      break;
    }
    await wait();
  }
  if (!enabled) throw new Error('Key did not become enabled');
  const pdf = await PDFDocument.create();
  pdf.addPage();
  pdflibAddPlaceholder({
    pdfDoc: pdf,
    name: 'Fixture only',
    reason: 'HSM smoke test',
    contactInfo: '',
    location: '',
    signatureLength: 16000,
    subFilter: SUBFILTER_ETSI_CADES_DETACHED,
  });
  class ProbeSigner extends Signer {
    async sign(content: Buffer) {
      return createDetachedCms(content, [pem], new Date(), (attributes) =>
        kms.sign(imported.name, attributes, new X509Certificate(pem), algorithm),
      );
    }
  }
  const signed = await new SignPdf().sign(
    Buffer.from(await pdf.save({ useObjectStreams: false })),
    new ProbeSigner(),
  );
  const signature = extractSignature(signed);
  writeFileSync(join(dir, 'fixture.pem'), pem);
  writeFileSync(join(dir, 'cms.der'), signature.cms);
  writeFileSync(join(dir, 'content.bin'), signature.content);
  openssl([
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
    'fixture.pem',
    '-purpose',
    'any',
    '-out',
    'verified.bin',
  ]);
  const trust = await tdidTrustBundle();
  for (const [i, url] of tdidCRLURLs.entries()) {
    const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error('CA CRL unavailable');
    const crl = Buffer.from(await res.arrayBuffer());
    if (crl.length > 8 * 1024 * 1024) throw new Error('CA CRL too large');
    writeFileSync(join(dir, 'crl.der'), crl);
    writeFileSync(join(dir, 'ca.pem'), i === 0 ? trust.root.pem : trust.issuer.pem);
    const dates = openssl([
      'crl',
      '-inform',
      'DER',
      '-in',
      'crl.der',
      '-verify',
      '-CAfile',
      'ca.pem',
      '-noout',
      '-lastupdate',
      '-nextupdate',
    ]).toString();
    const start = new Date(dates.match(/lastUpdate=(.+)/)?.[1] ?? '').getTime();
    const end = new Date(dates.match(/nextUpdate=(.+)/)?.[1] ?? '').getTime();
    if (!(start <= Date.now() && Date.now() < end)) throw new Error('CA CRL is stale');
  }
  console.log(
    JSON.stringify({
      probe: id,
      status: 'passed',
      keyVersion: imported.name,
      checks: [
        'browser_p12_wrap',
        'real_hsm_import',
        'key_certificate_match',
        'kms_crc32c',
        'real_hsm_sign',
        'openssl_cades_verify',
        'ca_crl_signature_and_dates',
      ],
      fixturePdfSha256: createHash('sha256').update(signed).digest('hex'),
      testOnly: true,
    }),
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
