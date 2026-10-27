import { describe, expect, it, vi } from 'vitest';
import type { Bucket } from '@google-cloud/storage';
import { BlobStore } from '../../packages/core/src/blobs.js';

// Emulates the provider's create precondition; tests our actual storage adapter.
function bucketFixture() {
  const objects = new Map<string, Buffer>();
  const save = vi.fn(
    async (
      name: string,
      bytes: Buffer,
      options: { preconditionOpts: { ifGenerationMatch: number } },
    ) => {
      if (options.preconditionOpts.ifGenerationMatch !== 0)
        throw new Error('Missing create-only precondition');
      if (objects.has(name)) throw Object.assign(new Error('Precondition Failed'), { code: 412 });
      objects.set(name, Buffer.from(bytes));
    },
  );
  return {
    objects,
    save,
    bucket: {
      file: (name: string) => ({
        save: (bytes: Buffer, options: { preconditionOpts: { ifGenerationMatch: number } }) =>
          save(name, bytes, options),
        download: async () => [objects.get(name)],
        exists: async () => [objects.has(name)],
      }),
    } as unknown as Bucket,
  };
}
describe('durable immutable cloud PDF objects', () => {
  it('another instance reads the stored bytes and cannot overwrite existing evidence', async () => {
    const fixture = bucketFixture();
    const first = await BlobStore.open('documents', fixture.bucket);
    const second = await BlobStore.open('documents', fixture.bucket);
    const id = '16a5a65d-f16d-4cb0-8008-f3c9411c314c';
    expect(await first.exists(id)).toBe(false);
    await first.write(id, Buffer.from('%PDF-original'));
    expect(await second.read(id)).toEqual(Buffer.from('%PDF-original'));
    await expect(second.write(id, Buffer.from('replacement'))).rejects.toMatchObject({ code: 412 });
    expect(await first.read(id)).toEqual(Buffer.from('%PDF-original'));
    expect(fixture.save.mock.calls[0][2]).toMatchObject({
      validation: 'crc32c',
      metadata: { cacheControl: 'private, no-store' },
    });
  });
  it('rejects path traversal before accessing cloud storage', async () => {
    const fixture = bucketFixture();
    const blobs = await BlobStore.open('signing', fixture.bucket);
    await expect(blobs.read('../../private')).rejects.toThrow('Invalid blob');
    expect(fixture.objects.size).toBe(0);
  });
});
