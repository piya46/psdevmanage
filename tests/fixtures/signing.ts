import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Ephemeral test CA, leaf, encrypted P12 and signed CRLs. Never real credentials. */
export function signingFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'pston-sign-fixture-'));
  const path = (name: string) => join(dir, name);
  const openssl = (args: string[], input?: string | Buffer) =>
    execFileSync('openssl', args, {
      cwd: dir,
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024,
    });
  for (const ca of ['root', 'issuer']) {
    mkdirSync(path(ca));
    writeFileSync(path(`${ca}/index`), '');
    writeFileSync(path(`${ca}/serial`), '1000\n');
    writeFileSync(path(`${ca}/crlnumber`), '1000\n');
    writeFileSync(
      path(`${ca}.cnf`),
      `[ ca ]\ndefault_ca = CA\n[ CA ]\ndatabase = ${ca}/index\nnew_certs_dir = ${ca}\nserial = ${ca}/serial\ncrlnumber = ${ca}/crlnumber\ncertificate = ${ca}.pem\nprivate_key = ${ca}.key\ndefault_md = sha256\ndefault_days = 2\ndefault_crl_days = 1\npolicy = policy\n[ policy ]\ncommonName = supplied\n[ ca_ext ]\nbasicConstraints = critical,CA:true\nkeyUsage = critical,keyCertSign,cRLSign\nsubjectKeyIdentifier = hash\nauthorityKeyIdentifier = keyid,issuer\n[ leaf_ext ]\nbasicConstraints = critical,CA:false\nkeyUsage = critical,digitalSignature,nonRepudiation\nextendedKeyUsage = emailProtection\nsubjectKeyIdentifier = hash\nauthorityKeyIdentifier = keyid,issuer\n`,
    );
  }
  openssl([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    'root.key',
    '-out',
    'root.pem',
    '-days',
    '2',
    '-subj',
    '/CN=PSTON Test Root',
    '-addext',
    'basicConstraints=critical,CA:true',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign',
  ]);
  for (const [name, signer, ext] of [
    ['issuer', 'root', 'ca_ext'],
    ['leaf', 'issuer', 'leaf_ext'],
  ]) {
    openssl([
      'req',
      '-new',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      `${name}.key`,
      '-out',
      `${name}.csr`,
      '-subj',
      `/CN=PSTON Test ${name}`,
    ]);
    openssl([
      'ca',
      '-batch',
      '-config',
      `${signer}.cnf`,
      '-in',
      `${name}.csr`,
      '-out',
      `${name}.pem`,
      '-extensions',
      ext,
      '-notext',
    ]);
  }
  openssl(
    [
      'pkcs12',
      '-export',
      '-in',
      'leaf.pem',
      '-inkey',
      'leaf.key',
      '-certfile',
      'issuer.pem',
      '-out',
      'leaf.p12',
      '-passout',
      'stdin',
    ],
    'fixture-only-password\n',
  );
  const crls = () =>
    ['root', 'issuer'].map((ca) => {
      openssl(['ca', '-config', `${ca}.cnf`, '-gencrl', '-out', `${ca}.crl`]);
      return readFileSync(path(`${ca}.crl`));
    });
  return {
    dir,
    path,
    openssl,
    crls,
    pem: readFileSync(path('leaf.pem'), 'utf8'),
    key: readFileSync(path('leaf.key'), 'utf8'),
    p12: readFileSync(path('leaf.p12')),
    bundle: {
      root: { pem: readFileSync(path('root.pem'), 'utf8') },
      issuer: { pem: readFileSync(path('issuer.pem'), 'utf8') },
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
