import { it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { inspectP12 } from '../../scripts/check-p12.mjs';

it('checks a real encrypted PKCS#12 locally without returning private material; rejects wrong passwords and certificates', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pston-p12-test-'));
  const openssl = (args, options = {}) =>
    execFileSync('openssl', args, { stdio: ['pipe', 'pipe', 'pipe'], ...options });
  const key = join(dir, 'test.key'),
    cert = join(dir, 'test.crt'),
    p12 = join(dir, 'test.p12');
  try {
    openssl([
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '1',
      '-subj',
      '/CN=PSTON fixture only',
      '-addext',
      'basicConstraints=critical,CA:FALSE',
    ]);
    openssl(['pkcs12', '-export', '-in', cert, '-inkey', key, '-out', p12, '-passout', 'stdin'], {
      input: 'fixture-password\n',
    });
    const run = (_command, args) =>
      openssl([...args, '-passin', 'stdin'], { input: 'fixture-password\n' });
    const result = inspectP12(p12, { run, expectedCertificate: cert });
    expect(result).toMatchObject({
      containsPrivateKey: true,
      certificateMatchesPrivateKey: true,
      rsaSha256HsmCandidate: true,
      productionSigningEnabled: false,
      trustChainChecked: false,
    });
    expect(JSON.stringify(result)).not.toMatch(/BEGIN |fixture-password/);
    expect(() =>
      inspectP12(p12, {
        run: (_c, args) => openssl([...args, '-passin', 'stdin'], { input: 'wrong\n' }),
      }),
    ).toThrow('Cannot decrypt');
    expect(() => inspectP12(p12, { run, now: new Date('2100-01-01') })).toThrow(
      'not currently valid',
    );
    openssl([
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(dir, 'other.key'),
      '-out',
      join(dir, 'other.crt'),
      '-days',
      '1',
      '-subj',
      '/CN=Other fixture',
    ]);
    expect(() => inspectP12(p12, { run, expectedCertificate: join(dir, 'other.crt') })).toThrow(
      'differs',
    );
    const empty = join(dir, 'certificate-only.p12');
    writeFileSync(empty, 'placeholder');
    expect(() => inspectP12(empty, { run: () => Buffer.from('no private key') })).toThrow(
      'exactly one private key',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
