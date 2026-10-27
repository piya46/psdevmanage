import { mkdirSync, existsSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { generateKeyPairSync, createPublicKey, X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';

if (existsSync('.env')) process.loadEnvFile('.env');
const root = resolve(process.env.PSTON_DATA_DIR ?? '.local');
mkdirSync(root, { recursive: true, mode: 0o700 });
const names = ['gateway', 'identity', 'documents', 'signing', 'audit'];
const split = process.argv.includes('--split-volumes');
const serviceRoot = (name) => (split ? join(root, name) : root);
const pubs = {};
for (const name of names) {
  const dir = join(serviceRoot(name), 'keys', name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!existsSync(join(dir, 'private.pem'))) {
    const pair = generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    writeFileSync(join(dir, 'private.pem'), pair.privateKey, { mode: 0o600 });
  }
  pubs[name] = createPublicKey(readFileSync(join(dir, 'private.pem'))).export({
    type: 'spki',
    format: 'pem',
  });
}
for (const directory of new Set(names.map(serviceRoot)))
  writeFileSync(join(directory, 'keys', 'public-keys.json'), JSON.stringify(pubs, null, 2), {
    mode: 0o644,
  });
const certDir = join(serviceRoot('signing'), 'services', 'signing', 'demo');
mkdirSync(certDir, { recursive: true, mode: 0o700 });
if (existsSync(join(certDir, 'key.pem')) !== existsSync(join(certDir, 'cert.pem')))
  throw new Error('Incomplete test identity: restore its matching certificate/key before starting');
if (!existsSync(join(certDir, 'cert.pem'))) {
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-sha256',
      '-nodes',
      '-keyout',
      join(certDir, 'key.pem'),
      '-out',
      join(certDir, 'cert.pem'),
      '-days',
      '365',
      '-subj',
      '/CN=PSTON TEST ONLY - NOT TDID/O=PSTON Development/C=TH',
      '-addext',
      'keyUsage=digitalSignature',
      '-addext',
      'basicConstraints=critical,CA:FALSE',
    ],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  );
  chmodSync(join(certDir, 'key.pem'), 0o600);
}
const key = createPublicKey(readFileSync(join(certDir, 'key.pem'))).export({
  type: 'spki',
  format: 'der',
});
const cert = new X509Certificate(readFileSync(join(certDir, 'cert.pem'))).publicKey.export({
  type: 'spki',
  format: 'der',
});
if (!key.equals(cert)) throw new Error('Test certificate and key do not match');
console.log(
  'Local identities and a TEST-ONLY certificate are ready. No TDID key has been imported.',
);
