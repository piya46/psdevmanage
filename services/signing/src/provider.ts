import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SignPdf } from '@signpdf/signpdf';
import { Signer } from '@signpdf/utils';
import { mode, serviceDir } from '../../../packages/core/src/config.js';
import { ensure } from '../../../packages/core/src/errors.js';

export interface SigningProvider {
  readonly name: string;
  readonly testOnly: boolean;
  signPreparedPdf(input: Buffer, signingTime: Date): Promise<Buffer>;
}
/** Local test key only. Production TDID credentials are never accepted here. */
export class DemoSigningProvider implements SigningProvider {
  readonly name = 'demo';
  readonly testOnly = true;
  async signPreparedPdf(input: Buffer, signingTime: Date) {
    ensure(
      mode === 'demo' && process.env.NODE_ENV !== 'production',
      503,
      'PROVIDER_DISABLED',
      'Test signing is disabled',
    );
    return new SignPdf().sign(input, new OpenSSLTestSigner(), signingTime);
  }
}
class OpenSSLTestSigner extends Signer {
  async sign(content: Buffer): Promise<Buffer> {
    const dir = await mkdtemp(join(tmpdir(), 'pston-test-sign-'));
    const keys = join(serviceDir('signing'), 'demo');
    try {
      await writeFile(join(dir, 'content.bin'), content, { mode: 0o600 });
      await promisify(execFile)(
        'openssl',
        [
          'cms',
          '-sign',
          '-binary',
          '-md',
          'sha256',
          '-cades',
          '-nosmimecap',
          '-in',
          join(dir, 'content.bin'),
          '-signer',
          process.env.PSTON_DEMO_CERT_FILE ?? join(keys, 'cert.pem'),
          '-inkey',
          process.env.PSTON_DEMO_KEY_FILE ?? join(keys, 'key.pem'),
          '-outform',
          'DER',
          '-out',
          join(dir, 'signature.der'),
        ],
        { timeout: 15000, maxBuffer: 1024 * 1024 },
      );
      return await readFile(join(dir, 'signature.der'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
