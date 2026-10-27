import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync } from 'node:fs';
import { createPrivateKey, X509Certificate, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Only public metadata leaves this function. No key or password is written to disk. */
export function inspectP12(
  file,
  { run = execFileSync, expectedCertificate, now = new Date() } = {},
) {
  if (!/\.(p12|pfx)$/i.test(file) || !lstatSync(file).isFile())
    throw new Error('Select a regular .p12 or .pfx file');
  let pem;
  try {
    // OpenSSL prompts on the local terminal with echo disabled. stdout, which
    // contains decrypted material, is captured in memory and never logged.
    pem = run('openssl', ['pkcs12', '-in', resolve(file), '-nodes'], {
      stdio: ['inherit', 'pipe', 'inherit'],
      maxBuffer: 1024 * 1024,
    });
  } catch {
    throw new Error(
      'Cannot decrypt PKCS#12. Check the local password, file and OpenSSL compatibility. No upload was made.',
    );
  }
  try {
    const text = pem.toString('utf8');
    const keys =
      text.match(
        /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC )?PRIVATE KEY-----/g,
      ) ?? [];
    if (keys.length !== 1) throw new Error('PKCS#12 must contain exactly one private key');
    const key = createPrivateKey(keys[0]);
    const certs = (
      text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? []
    ).map((p) => new X509Certificate(p));
    const matching = certs.filter((c) => c.checkPrivateKey(key));
    if (matching.length !== 1) throw new Error('No unique certificate matches the private key');
    const cert = matching[0];
    if (cert.ca) throw new Error('A CA certificate cannot be used as a personal signing identity');
    if (now < new Date(cert.validFrom) || now > new Date(cert.validTo))
      throw new Error('Certificate is not currently valid');
    if (
      expectedCertificate &&
      !cert.raw.equals(new X509Certificate(readFileSync(expectedCertificate)).raw)
    )
      throw new Error('The certificate in PKCS#12 differs from the supplied .cer/.crt');
    const details = key.asymmetricKeyDetails;
    return {
      containsPrivateKey: true,
      certificateMatchesPrivateKey: true,
      subject: cert.subject,
      issuer: cert.issuer,
      serial: cert.serialNumber,
      sha256: createHash('sha256').update(cert.raw).digest('hex'),
      validFrom: new Date(cert.validFrom).toISOString(),
      validTo: new Date(cert.validTo).toISOString(),
      algorithm: key.asymmetricKeyType,
      bits: details?.modulusLength,
      curve: details?.namedCurve,
      rsaSha256HsmCandidate:
        key.asymmetricKeyType === 'rsa' &&
        [2048, 3072, 4096].includes(details?.modulusLength) &&
        details?.publicExponent === 65537n,
      certificatesInBundle: certs.length,
      trustChainChecked: false,
      revocationChecked: false,
      tdidPolicyChecked: false,
      productionSigningEnabled: false,
    };
  } finally {
    if (Buffer.isBuffer(pem)) pem.fill(0);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.includes('--help') || args.length === 0) {
      console.log(
        'npm run cert:check -- --file /absolute/path/certificate.p12 [--certificate /absolute/path/cert.cer]\nPassword is entered locally in Terminal. No cloud calls, uploads, key export or deployment.',
      );
    } else {
      const values = {};
      for (let i = 0; i < args.length; i += 2) {
        if (
          !['--file', '--certificate'].includes(args[i]) ||
          !args[i + 1] ||
          args[i + 1].startsWith('--')
        )
          throw new Error(
            'Use --file PATH and optionally --certificate PATH; passwords are never CLI arguments',
          );
        values[args[i]] = args[i + 1];
      }
      if (!process.stdin.isTTY)
        throw new Error(
          'Run this command in an interactive local Terminal to enter the P12 password',
        );
      if (!values['--file']) throw new Error('--file is required');
      console.log(
        JSON.stringify(
          inspectP12(values['--file'], { expectedCertificate: values['--certificate'] }),
          null,
          2,
        ),
      );
      console.log(
        'Local key/certificate check only. TDID policy, certificate chain, revocation and HSM integration still need acceptance.',
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
