import { expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

it('bootstraps isolated service volumes without replacing existing keys on restart', () => {
  const root = mkdtempSync(join(tmpdir(), 'pston-volumes-'));
  try {
    const setup = () =>
      execFileSync(process.execPath, ['scripts/setup.mjs', '--split-volumes'], {
        env: { ...process.env, PSTON_DATA_DIR: root },
        stdio: 'ignore',
      });
    setup();
    const names = ['gateway', 'identity', 'documents', 'signing', 'audit'];
    const before = names.map((name) =>
      readFileSync(join(root, name, 'keys', name, 'private.pem'), 'utf8'),
    );
    const cert = readFileSync(
      join(root, 'signing', 'services', 'signing', 'demo', 'cert.pem'),
      'utf8',
    );
    setup();
    for (const [i, name] of names.entries()) {
      expect(readdirSync(join(root, name, 'keys')).sort()).toEqual(
        [name, 'public-keys.json'].sort(),
      );
      expect(readFileSync(join(root, name, 'keys', name, 'private.pem'), 'utf8')).toBe(before[i]);
      expect(
        Object.keys(
          JSON.parse(readFileSync(join(root, name, 'keys', 'public-keys.json'), 'utf8')),
        ).sort(),
      ).toEqual([...names].sort());
      if (name !== 'signing')
        expect(existsSync(join(root, name, 'services', 'signing'))).toBe(false);
    }
    expect(
      readFileSync(join(root, 'signing', 'services', 'signing', 'demo', 'cert.pem'), 'utf8'),
    ).toBe(cert);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
