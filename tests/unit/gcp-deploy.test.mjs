import { describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  existsSync,
  chmodSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  parseOptions,
  sourceFiles,
  assertOwned,
  assertPrivatePolicy,
  invocationGraph,
  deploymentEnv,
  assertGatewayPolicy,
} from '../../scripts/lib/gcp-deploy.mjs';

describe('Cloud Run deployment boundaries', () => {
  it('requires a private allowlisted production env file and never puts secrets in a dry run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pston-production-env-'));
    const file = join(dir, '.env.production');
    const content =
      'PSTON_DEPLOY_ENVIRONMENT=production\nPSTON_GCP_PROJECT=example-project\nWEB_ORIGIN=https://sign.example.test\nGOOGLE_CLIENT_ID=test.apps.googleusercontent.com\nGOOGLE_CLIENT_SECRET=never-print-this-value\nGOOGLE_ALLOWED_EMAILS=owner@gmail.com\n';
    try {
      writeFileSync(file, content, { mode: 0o600 });
      const args = ['--env-file', file, '--dry-run'];
      expect(parseOptions(args, deploymentEnv(args, dir, {}))).toMatchObject({
        environment: 'production',
        name: 'pston-prod',
        proxy: false,
      });
      const result = spawnSync(process.execPath, ['scripts/deploy-gcp.mjs', ...args], {
        encoding: 'utf8',
        env: { ...process.env, PATH: '/not-installed' },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).not.toContain('never-print-this-value');
      expect(JSON.parse(result.stdout).cloudSQL.availability).toBe('REGIONAL');
      writeFileSync(file, content + 'PSTON_DEMO_KEY_FILE=/key.pem\n');
      expect(() => deploymentEnv(args, dir, {})).toThrow('Unsupported');
      writeFileSync(file, content);
      chmodSync(file, 0o644);
      expect(() => deploymentEnv(args, dir, {})).toThrow('chmod 600');
      expect(() =>
        assertGatewayPolicy(
          { bindings: [{ role: 'roles/owner', members: ['allUsers'] }] },
          'Gateway',
        ),
      ).toThrow('unexpected public');
      expect(() =>
        assertGatewayPolicy(
          { bindings: [{ role: 'roles/run.invoker', members: ['allUsers'] }] },
          'Gateway',
        ),
      ).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('requires an explicit project and rejects unsafe or ambiguous arguments', () => {
    expect(() => parseOptions([], { CLOUDSDK_CORE_PROJECT: 'unrelated-project' })).toThrow(
      'Specify --project',
    );
    for (const args of [
      ['--project', 'bad;command'],
      ['--project', 'example-project', '--name', 'bad/name'],
      ['--project', 'example-project', '--port', '80'],
    ])
      expect(() => parseOptions(args, {})).toThrow();
    expect(parseOptions(['--project', 'example-project'], {})).toMatchObject({
      region: 'asia-southeast1',
      name: 'pston-dev',
      proxy: true,
      origin: 'http://localhost:5180',
    });
  });
  it('refuses resources with another owner and inherited public IAM', () => {
    const config = parseOptions(['--project', 'example-project'], {});
    expect(() => assertOwned({ labels: {} }, config, 'Database')).toThrow('not owned');
    expect(() => assertPrivatePolicy({ bindings: [{ members: ['allUsers'] }] }, 'Gateway')).toThrow(
      'public IAM',
    );
    expect(() =>
      assertPrivatePolicy({ bindings: [{ members: ['allAuthenticatedUsers'] }] }, 'Project'),
    ).toThrow('public IAM');
    expect(invocationGraph().identity).not.toContain('signing');
    expect(invocationGraph().documents).toContain('signing');
  });
  it('packages source without local databases, PDF documents, credentials or symlinks', () => {
    const root = mkdtempSync(join(tmpdir(), 'pston-source-test-'));
    try {
      for (const name of [
        'Dockerfile',
        '.dockerignore',
        'package.json',
        'package-lock.json',
        'tsconfig.json',
      ])
        writeFileSync(join(root, name), '{}');
      for (const name of ['apps', 'packages', 'services', 'scripts', 'assets', 'infra/gcp'])
        mkdirSync(join(root, name), { recursive: true });
      for (const name of [
        '.env',
        'key.pem',
        'key.p12',
        'cert.cer',
        'cert.crt',
        'document.pdf',
        'store.sqlite',
      ])
        writeFileSync(join(root, 'apps', name), 'private');
      writeFileSync(join(root, 'apps', 'index.ts'), 'export {};');
      expect(sourceFiles(root)).toContain('apps/index.ts');
      expect(sourceFiles(root).filter((f) => f.startsWith('apps/'))).toEqual(['apps/index.ts']);
      symlinkSync('/private/tmp', join(root, 'apps', 'linked'));
      expect(() => sourceFiles(root)).toThrow('symlink rejected');
      rmSync(join(root, 'apps', 'linked'));
      writeFileSync(
        join(root, 'apps', 'credentials.json'),
        JSON.stringify({ private_key: 'private' }),
      );
      expect(() => sourceFiles(root)).toThrow('credentials');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('dry run succeeds with no gcloud and does not create local deployment state', () => {
    const before = existsSync('.local/gcp-deploy/example-project');
    const result = spawnSync(
      process.execPath,
      ['scripts/deploy-gcp.mjs', '--project', 'example-project', '--dry-run'],
      { encoding: 'utf8', env: { ...process.env, PATH: '/not-installed' } },
    );
    expect(result.status, result.stderr).toBe(0);
    const plan = JSON.parse(result.stdout);
    expect(plan.mutations).toBe(false);
    expect(plan.services).toHaveLength(5);
    expect(plan.cloudSQL.version).toBe('POSTGRES_17');
    expect(plan.sourceFiles.some((f) => f.includes('.env') || f.includes('.local'))).toBe(false);
    expect(existsSync('.local/gcp-deploy/example-project')).toEqual(before);
  });
});
