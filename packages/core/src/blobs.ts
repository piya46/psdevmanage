import { Storage, type Bucket } from '@google-cloud/storage';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { serviceDir } from './config.js';

/** Immutable PDF objects: create-only writes prevent overwriting signed evidence. */
export class BlobStore {
  private constructor(
    private directory: string,
    private bucket?: Bucket,
  ) {}
  static async open(service: 'documents' | 'signing', bucket?: Bucket) {
    const name = process.env.PSTON_BLOB_BUCKET;
    if (process.env.K_SERVICE && !name && !bucket)
      throw new Error('Cloud Run blob bucket is required');
    const directory = join(serviceDir(service), service === 'documents' ? 'blobs' : 'results');
    if (!name && !bucket) await mkdir(directory, { recursive: true, mode: 0o700 });
    return new BlobStore(directory, bucket ?? (name ? new Storage().bucket(name) : undefined));
  }
  private name(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid blob ID');
    return id + '.pdf';
  }
  async write(id: string, bytes: Buffer) {
    const name = this.name(id);
    if (this.bucket)
      await this.bucket.file(name).save(bytes, {
        resumable: false,
        validation: 'crc32c',
        preconditionOpts: { ifGenerationMatch: 0 },
        metadata: { contentType: 'application/pdf', cacheControl: 'private, no-store' },
      });
    else await writeFile(join(this.directory, name), bytes, { flag: 'wx', mode: 0o600 });
  }
  async read(id: string): Promise<Buffer> {
    const name = this.name(id);
    return this.bucket
      ? (await this.bucket.file(name).download({ validation: 'crc32c' }))[0]
      : readFile(join(this.directory, name));
  }
  async exists(id: string) {
    const name = this.name(id);
    if (this.bucket) return (await this.bucket.file(name).exists())[0];
    try {
      await access(join(this.directory, name));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
}
