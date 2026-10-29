import { findByteRange, removeTrailingNewLine } from '@signpdf/utils';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sha256 } from './security.js';
import { ensure } from './errors.js';
import { validateSigningTrust, tdidTrustBundle } from './certificate-trust.js';

export function preparedDigest(input: Buffer) {
  let pdf = removeTrailingNewLine(input);
  const { byteRangePlaceholder, byteRangePlaceholderPosition } = findByteRange(pdf);
  ensure(
    byteRangePlaceholder && byteRangePlaceholderPosition !== undefined,
    400,
    'MISSING_PLACEHOLDER',
    'Signature placeholder missing',
  );
  const end = byteRangePlaceholderPosition + byteRangePlaceholder.length;
  const contents = pdf.indexOf('/Contents ', end),
    start = pdf.indexOf('<', contents),
    stop = pdf.indexOf('>', start) + 1;
  ensure(
    contents >= 0 && start > 0 && stop > start,
    400,
    'INVALID_PLACEHOLDER',
    'Invalid signature placeholder',
  );
  const range = [0, start, stop, pdf.length - stop];
  const actual = `/ByteRange [${range.join(' ')}]`.padEnd(byteRangePlaceholder.length, ' ');
  ensure(actual.length === byteRangePlaceholder.length, 400, 'INVALID_RANGE', 'ByteRange overflow');
  pdf = Buffer.concat([
    pdf.subarray(0, byteRangePlaceholderPosition),
    Buffer.from(actual),
    pdf.subarray(end),
  ]);
  return { digest: sha256(Buffer.concat([pdf.subarray(0, start), pdf.subarray(stop)])), range };
}
export function extractSignature(pdf: Buffer) {
  const matches = [
    ...pdf.toString('latin1').matchAll(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g),
  ];
  ensure(
    matches.length === 1,
    422,
    'SIGNATURE_COUNT_UNSUPPORTED',
    'This validator currently requires exactly one signature',
  );
  const [a, b, c, d] = matches[0].slice(1).map(Number);
  ensure(
    [a, b, c, d].every(Number.isSafeInteger) &&
      a === 0 &&
      b > 0 &&
      c > b &&
      d >= 0 &&
      c + d === pdf.length,
    422,
    'INVALID_BYTE_RANGE',
    'Signature does not cover the complete revision',
  );
  const encoded = pdf.subarray(b, c).toString('ascii');
  ensure(/^<[\da-fA-F]+>$/.test(encoded), 422, 'INVALID_CONTENTS', 'Invalid signature container');
  const der = Buffer.from(encoded.slice(1, -1), 'hex');
  ensure(der[0] === 0x30, 422, 'INVALID_CMS', 'Invalid CMS');
  let size = der[1],
    offset = 2;
  if (size & 0x80) {
    const bytes = size & 0x7f;
    ensure(bytes > 0 && bytes <= 4, 422, 'INVALID_CMS', 'Invalid CMS length');
    size = 0;
    for (let i = 0; i < bytes; i++) size = size * 256 + der[offset++];
  }
  ensure(offset + size <= der.length, 422, 'INVALID_CMS', 'Truncated CMS');
  const content = Buffer.concat([pdf.subarray(0, b), pdf.subarray(c)]);
  return {
    cms: der.subarray(0, offset + size),
    content,
    digest: sha256(content),
    range: [a, b, c, d],
  };
}
export async function verifyPdf(pdf: Buffer) {
  const extracted = extractSignature(pdf);
  const dir = await mkdtemp(join(tmpdir(), 'pston-verify-'));
  try {
    await Promise.all([
      writeFile(join(dir, 'cms.der'), extracted.cms, { mode: 0o600 }),
      writeFile(join(dir, 'content.bin'), extracted.content, { mode: 0o600 }),
    ]);
    await promisify(execFile)(
      'openssl',
      [
        'cms',
        '-verify',
        '-binary',
        '-inform',
        'DER',
        '-in',
        join(dir, 'cms.der'),
        '-content',
        join(dir, 'content.bin'),
        '-noverify',
        '-signer',
        join(dir, 'signer.pem'),
        '-out',
        join(dir, 'verified.bin'),
      ],
      { timeout: 15000, maxBuffer: 1024 * 1024 },
    );
    const certificate = new X509Certificate(await readFile(join(dir, 'signer.pem')));
    let trust: 'trusted' | 'untrusted' | 'unknown' = 'untrusted';
    let revocation: 'good' | 'not_checked' | 'unknown' = 'not_checked';
    let trustCheckedAt: string | undefined;
    const bundle = await tdidTrustBundle();
    if (certificate.checkIssued(new X509Certificate(bundle.issuer.pem))) {
      try {
        const checked = await validateSigningTrust(certificate.toString(), { bundle });
        trust = checked.trust;
        revocation = checked.revocation;
        trustCheckedAt = checked.checkedAt;
      } catch {
        trust = 'unknown';
        revocation = 'unknown';
      }
    }
    return {
      crypto: 'valid' as const,
      trust,
      revocation,
      trustCheckedAt,
      timestamp: 'none' as const,
      modification: 'whole_revision_covered' as const,
      sha256: sha256(pdf),
      documentDigest: extracted.digest,
      certificateFingerprint: sha256(certificate.raw),
      byteRange: extracted.range,
      validator: 'OpenSSL CMS; TDID G3 / NRCA G1 chain and CRL validation when applicable',
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
