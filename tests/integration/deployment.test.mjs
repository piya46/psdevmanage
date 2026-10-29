import { it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { main } from '../../scripts/deploy-gcp.mjs';

function fixture(production = false) {
  const workspace = mkdtempSync(join(tmpdir(), 'pston-deploy-test-'));
  for (const file of [
    'Dockerfile',
    '.dockerignore',
    'package.json',
    'package-lock.json',
    'tsconfig.json',
  ])
    writeFileSync(join(workspace, file), '{}');
  for (const dir of ['apps', 'packages', 'services', 'scripts', 'assets', 'infra/gcp'])
    mkdirSync(join(workspace, dir), { recursive: true });
  writeFileSync(join(workspace, 'infra/gcp/cloudbuild.json'), '{}');
  writeFileSync(join(workspace, '.env'), 'SHOULD_NEVER_UPLOAD=secret');
  const state = {
    accounts: {},
    repo: null,
    secrets: {},
    sql: null,
    buckets: {},
    jobs: {},
    services: {},
    schedules: {},
    publicServices: new Set(),
    commands: [],
    builds: 0,
    publicProject: false,
    failBuild: false,
    billing: { billingEnabled: true },
    keyRing: null,
    hsmRole: null,
    projectPolicy: { etag: 'fixture-etag', bindings: [], auditConfigs: [] },
  };
  const value = (args, key) =>
    args.find((a) => a.startsWith(key + '='))?.slice(key.length + 1) ?? args[args.indexOf(key) + 1];
  const missing = (detail = 'NOT_FOUND') => {
    throw Object.assign(new Error('not found'), { detail });
  };
  const run = (command, args, options = {}) => {
    if (command === 'openssl')
      return execFileSync(command, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    expect(command).toBe('gcloud');
    state.commands.push(args);
    expect(value(args, '--project')).toBe('example-project');
    const is = (prefix) => args.slice(0, prefix.split(' ').length).join(' ') === prefix;
    const result = (data) => JSON.stringify(data);
    if (is('auth list')) return result([{ account: 'operator@example.test' }]);
    if (is('auth print-access-token') || is('auth print-identity-token')) return 'mock-token';
    if (is('projects describe'))
      return result({ lifecycleState: 'ACTIVE', projectNumber: '123456789' });
    if (is('projects get-iam-policy'))
      return result({ bindings: state.publicProject ? [{ members: ['allUsers'] }] : [] });
    if (is('billing projects describe')) return result(state.billing);
    if (is('run services get-iam-policy'))
      return result({
        bindings: state.publicServices.has(args[3])
          ? [{ role: 'roles/run.invoker', members: ['allUsers'] }]
          : [],
      });
    if (is('run services add-iam-policy-binding') && args.includes('--member=allUsers'))
      state.publicServices.add(args[3]);
    if (args.includes('get-iam-policy')) return result({ bindings: [] });
    if (args.includes('add-iam-policy-binding') || is('services enable')) return '';
    if (is('iam service-accounts describe')) return result(state.accounts[args[3]] ?? missing());
    if (is('iam service-accounts create')) {
      state.accounts[args[3] + '@example-project.iam.gserviceaccount.com'] = {
        description: value(args, '--description'),
      };
      return '';
    }
    if (is('kms keyrings describe')) return result(state.keyRing ?? missing());
    if (is('kms keyrings create')) {
      state.keyRing = { name: args[3] };
      return '';
    }
    if (is('iam roles describe')) return result(state.hsmRole ?? missing());
    if (is('iam roles create') || is('iam roles update')) {
      state.hsmRole = {
        description: value(args, '--description'),
        permissions: value(args, '--permissions').split(','),
      };
      return '';
    }
    if (is('artifacts repositories describe')) return result(state.repo ?? missing());
    if (is('artifacts repositories create')) {
      state.repo = {
        labels: Object.fromEntries(
          value(args, '--labels')
            .split(',')
            .map((v) => v.split('=')),
        ),
      };
      return '';
    }
    if (is('secrets describe')) return result(state.secrets[args[2]] ?? missing());
    if (is('secrets create')) {
      state.secrets[args[2]] = {
        labels: Object.fromEntries(
          value(args, '--labels')
            .split(',')
            .map((v) => v.split('=')),
        ),
        versions: [],
      };
      return '';
    }
    if (is('secrets versions list'))
      return result(
        state.secrets[args[3]].versions
          .map((_, i) => ({
            name: `projects/example-project/secrets/${args[3]}/versions/${i + 1}`,
          }))
          .reverse()
          .slice(0, 1),
      );
    if (is('secrets versions add')) {
      state.secrets[args[3]].versions.push(String(options.input));
      return '';
    }
    if (is('secrets versions access'))
      return state.secrets[value(args, '--secret')].versions[Number(args[3]) - 1].trim();
    if (is('builds submit')) {
      if (state.failBuild) throw new Error('simulated build failure');
      const files = readdirSync(args[2]);
      expect(files).not.toContain('.env');
      expect(files).not.toContain('.local');
      expect(files).not.toContain('key.pem');
      state.builds++;
      return '';
    }
    if (is('run jobs describe'))
      return result(state.jobs[args[3]] ?? missing(`Cannot find job [${args[3]}].`));
    if (is('run jobs deploy')) {
      state.jobs[args[3]] = {
        metadata: {
          labels: Object.fromEntries(
            value(args, '--labels')
              .split(',')
              .map((v) => v.split('=')),
          ),
        },
      };
      return '';
    }
    if (is('run jobs execute')) return '';
    if (is('run jobs delete')) {
      delete state.jobs[args[3]];
      return '';
    }
    if (is('run services describe'))
      return result(state.services[args[3]] ?? missing(`Cannot find service [${args[3]}].`));
    if (is('run deploy')) {
      const env = JSON.parse(readFileSync(value(args, '--env-vars-file'), 'utf8'));
      state.services[args[2]] = {
        metadata: {
          labels: Object.fromEntries(
            value(args, '--labels')
              .split(',')
              .map((v) => v.split('=')),
          ),
        },
        spec: {
          template: {
            spec: {
              containers: [{ env: Object.entries(env).map(([name, value]) => ({ name, value })) }],
            },
          },
        },
        status: { url: `https://${args[2]}.example.test` },
      };
      return '';
    }
    if (is('scheduler jobs describe')) return result(state.schedules[args[3]] ?? missing());
    if (is('scheduler jobs create http') || is('scheduler jobs update http')) {
      state.schedules[args[4]] = { description: value(args, '--description') };
      return '';
    }
    throw new Error('Unexpected mock command: ' + args.join(' '));
  };
  const response = (data, status = 200, headers = {}) =>
    new Response(JSON.stringify(data), { status, headers });
  const fetch = async (url, options = {}) => {
    const parsed = new URL(url),
      body = options.body ? JSON.parse(options.body) : undefined;
    if (parsed.hostname === 'cloudresourcemanager.googleapis.com') {
      if (parsed.pathname.endsWith(':setIamPolicy')) state.projectPolicy = body.policy;
      return response(state.projectPolicy);
    }
    if (parsed.hostname === 'sqladmin.googleapis.com') {
      if (parsed.pathname.endsWith('/instances') && options.method === 'POST') {
        state.sql = {
          ...body,
          connectionName: 'example-project:asia-southeast1:pston-dev-sql',
          state: 'RUNNABLE',
        };
        return response({ name: 'create-db' });
      }
      if (parsed.pathname.includes('/operations/')) return response({ status: 'DONE' });
      return state.sql ? response(state.sql) : response({ error: { status: 'NOT_FOUND' } }, 404);
    }
    if (parsed.hostname === 'storage.googleapis.com') {
      if (options.method === 'POST') {
        state.buckets[body.name] = body;
        return response(body);
      }
      const bucket = state.buckets[parsed.pathname.split('/').at(-1)];
      return bucket ? response(bucket) : response({ error: { status: 'NOT_FOUND' } }, 404);
    }
    if (parsed.pathname === '/api/session')
      return response({ mode: production ? 'google' : 'demo' });
    if (parsed.pathname === '/ready')
      return response({
        status: 'ok',
        release: state.services['pston-prod-gateway'].spec.template.spec.containers[0].env.find(
          (v) => v.name === 'PSTON_RELEASE',
        ).value,
      });
    if (production && parsed.pathname === '/api/auth/demo') return response({}, 404);
    if (production && parsed.pathname === '/api/documents') return response({}, 401);
    if (production && parsed.pathname === '/api/auth/google/start')
      return response({}, 302, {
        location:
          'https://accounts.google.com/o/oauth2/v2/auth?client_id=test.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Fsign.example.test%2Fapi%2Fauth%2Fgoogle%2Fcallback',
        'set-cookie': '__Host-pston_oauth=mock; Path=/; Secure; HttpOnly; SameSite=Lax',
      });
    if (parsed.pathname === '/api/auth/demo')
      return response({ csrf: 'mock-csrf' }, 200, { 'set-cookie': 'pston_session=mock; HttpOnly' });
    if (parsed.pathname === '/api/system')
      return response({
        services: ['identity', 'documents', 'signing', 'audit'].map((name) => ({
          name,
          status: 'ok',
        })),
      });
    if (parsed.pathname === '/api/auth/logout') return response({ ok: true });
    throw new Error('Unexpected mock HTTP request');
  };
  return {
    state,
    workspace,
    run,
    fetch,
    cleanup: () => rmSync(workspace, { recursive: true, force: true }),
  };
}

it('orchestrates first deployment and repeat deployment without replacing secrets or storage', async () => {
  const f = fixture();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const options = {
      args: ['--project', 'example-project', '--no-proxy'],
      workspace: f.workspace,
      run: f.run,
      fetch: f.fetch,
    };
    await main(options);
    const passwords = JSON.stringify(f.state.secrets);
    const sql = f.state.sql;
    expect(Object.keys(f.state.services)).toHaveLength(5);
    expect(Object.keys(f.state.schedules)).toHaveLength(3);
    expect(Object.keys(f.state.jobs)).toHaveLength(0);
    expect(sql.settings.connectorEnforcement).toBe('REQUIRED');
    expect(sql.settings.deletionProtectionEnabled).toBe(true);
    expect(sql.settings.ipConfiguration.authorizedNetworks).toEqual([]);
    expect(
      Object.values(f.state.buckets).every(
        (b) => b.iamConfiguration.publicAccessPrevention === 'enforced',
      ),
    ).toBe(true);
    const deployments = f.state.commands.filter((a) => a[0] === 'run' && a[1] === 'deploy');
    for (const args of deployments) {
      expect(args).toContain('--invoker-iam-check');
      expect(args).toContain('--no-allow-unauthenticated');
    }
    expect(f.state.commands.some((a) => a.includes('--member=allUsers'))).toBe(false);
    await main(options);
    expect(f.state.sql).toBe(sql);
    expect(JSON.stringify(f.state.secrets)).toBe(passwords);
    expect(f.state.builds).toBe(2);
  } finally {
    log.mockRestore();
    f.cleanup();
  }
}, 30000);

it('stops before provisioning when the project grants public access', async () => {
  const f = fixture();
  f.state.publicProject = true;
  try {
    await expect(
      main({
        args: ['--project', 'example-project', '--no-proxy'],
        workspace: f.workspace,
        run: f.run,
        fetch: f.fetch,
      }),
    ).rejects.toThrow('public IAM');
    expect(f.state.sql).toBeNull();
    expect(f.state.builds).toBe(0);
  } finally {
    f.cleanup();
  }
});

it('deploys production with Google secrets, HA SQL and only the gateway public; repeat run preserves data', async () => {
  const f = fixture(true);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const path = join(f.workspace, '.env.production');
  const configuration =
    'PSTON_DEPLOY_ENVIRONMENT=production\nPSTON_GCP_PROJECT=example-project\nWEB_ORIGIN=https://sign.example.test\nGOOGLE_CLIENT_ID=test.apps.googleusercontent.com\nGOOGLE_CLIENT_SECRET=local-secret-one\nGOOGLE_ALLOWED_EMAILS=owner@gmail.com\n';
  writeFileSync(path, configuration, { mode: 0o600 });
  const options = {
    args: ['--env-file', path],
    workspace: f.workspace,
    run: f.run,
    fetch: f.fetch,
  };
  try {
    await main(options);
    expect(f.state.sql.settings.availabilityType).toBe('REGIONAL');
    expect(f.state.sql.settings.backupConfiguration.backupRetentionSettings.retainedBackups).toBe(
      30,
    );
    expect([...f.state.publicServices]).toEqual(['pston-prod-gateway']);
    expect(Object.keys(f.state.secrets).some((s) => s.includes('demo'))).toBe(false);
    for (const [name, resource] of Object.entries(f.state.services)) {
      const env = Object.fromEntries(
        resource.spec.template.spec.containers[0].env.map((v) => [v.name, v.value]),
      );
      expect(env.NODE_ENV).toBe('production');
      expect(env.PSTON_MODE).toBe('google');
      expect(env.PSTON_SIGNING_PROVIDER).toBe('disabled');
      expect(JSON.stringify(env)).not.toContain('local-secret');
      if (name.endsWith('-identity')) {
        expect(env.GOOGLE_CLIENT_ID).toBe('test.apps.googleusercontent.com');
        expect(env.GOOGLE_ALLOWED_EMAILS).toBe('owner@gmail.com');
        expect(env.GOOGLE_ALLOWED_SUBS).toBeUndefined();
      } else {
        expect(env.GOOGLE_CLIENT_ID).toBeUndefined();
        expect(env.GOOGLE_ALLOWED_EMAILS).toBeUndefined();
      }
    }
    const first = JSON.stringify(f.state.secrets);
    await main(options);
    expect(JSON.stringify(f.state.secrets)).toBe(first);
    writeFileSync(path, configuration.replace('local-secret-one', 'local-secret-two'));
    await main(options);
    expect(f.state.secrets['pston-prod-google-client-secret'].versions).toEqual([
      'local-secret-one',
      'local-secret-two',
    ]);
    const identity = f.state.commands
      .filter((c) => c[0] === 'run' && c[1] === 'deploy' && c[2] === 'pston-prod-identity')
      .at(-1);
    expect(identity.find((v) => v.startsWith('--set-secrets='))).toContain(
      'GOOGLE_CLIENT_SECRET=pston-prod-google-client-secret:2',
    );
    expect(JSON.stringify(f.state.commands)).not.toContain('local-secret');
    expect(JSON.stringify(log.mock.calls)).not.toContain('local-secret');
    f.state.sql.settings.availabilityType = 'ZONAL';
    await expect(main(options)).rejects.toThrow('Production Cloud SQL requires HA');
  } finally {
    log.mockRestore();
    f.cleanup();
  }
}, 30000);

it('enables HSM with dedicated key-ring permissions and audit logs, without P12 secrets or project-wide KMS grants', async () => {
  const f = fixture(true);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const path = join(f.workspace, '.env.production');
  writeFileSync(
    path,
    'PSTON_DEPLOY_ENVIRONMENT=production\nPSTON_GCP_PROJECT=example-project\nWEB_ORIGIN=https://sign.example.test\nGOOGLE_CLIENT_ID=test.apps.googleusercontent.com\nGOOGLE_CLIENT_SECRET=fixture\nGOOGLE_ALLOWED_EMAILS=owner@gmail.com\nPSTON_SIGNING_PROVIDER=google-cloud-hsm\n',
    { mode: 0o600 },
  );
  try {
    const options = {
      args: ['--env-file', path],
      workspace: f.workspace,
      run: f.run,
      fetch: f.fetch,
    };
    await main(options);
    await main(options);
    const env = Object.fromEntries(
      f.state.services['pston-prod-signing'].spec.template.spec.containers[0].env.map(
        ({ name, value }) => [name, value],
      ),
    );
    expect(env.PSTON_KMS_KEY_RING).toBe(
      'projects/example-project/locations/asia-southeast1/keyRings/pston-prod-tdid',
    );
    expect(env.PSTON_SIGNING_PROVIDER).toBe('google-cloud-hsm');
    expect(f.state.hsmRole.permissions).toContain('cloudkms.cryptoKeyVersions.useToSign');
    expect(f.state.hsmRole.permissions).not.toContain('cloudkms.cryptoKeyVersions.destroy');
    expect(f.state.projectPolicy.auditConfigs).toEqual([
      {
        service: 'cloudkms.googleapis.com',
        auditLogConfigs: [{ logType: 'DATA_READ' }, { logType: 'DATA_WRITE' }],
      },
    ]);
    expect(
      f.state.commands.filter(
        (c) => c[0] === 'projects' && c.some((arg) => arg.includes('hsm_signing')),
      ),
    ).toEqual([]);
    expect(JSON.stringify(f.state.secrets)).not.toMatch(/p12|PRIVATE KEY-----.*TDID/s);
  } finally {
    log.mockRestore();
    f.cleanup();
  }
}, 30000);

it('identifies an unlinked or disabled billing account and stops before creating cloud resources', async () => {
  for (const billingAccountName of ['', 'billingAccounts/test-billing-account']) {
    const f = fixture();
    f.state.billing = { billingEnabled: false, billingAccountName };
    try {
      await expect(
        main({
          args: ['--project', 'example-project', '--no-proxy'],
          workspace: f.workspace,
          run: f.run,
          fetch: f.fetch,
        }),
      ).rejects.toThrow(
        billingAccountName
          ? 'billing account is linked, but billing is disabled'
          : 'No billing account is linked',
      );
      expect(f.state.sql).toBeNull();
      expect(f.state.builds).toBe(0);
      expect(Object.keys(f.state.accounts)).toHaveLength(0);
      expect(Object.keys(f.state.secrets)).toHaveLength(0);
      expect(
        f.state.commands.some(
          (args) => args.includes('enable') || args.includes('create') || args.includes('link'),
        ),
      ).toBe(false);
    } finally {
      f.cleanup();
    }
  }
});

it('reports non-JSON Google API failures without exposing response contents or continuing deployment', async () => {
  const f = fixture();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const responseBody = 'An error occurred: sensitive upstream response';
  try {
    const error = await main({
      args: ['--project', 'example-project', '--no-proxy'],
      workspace: f.workspace,
      run: f.run,
      fetch: async () => new Response(responseBody, { status: 503 }),
    }).catch((error) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain(
      'Google API GET storage.googleapis.com/storage/v1/b/example-project-pston-dev-documents: HTTP 503',
    );
    expect(error.message).toContain('not valid JSON');
    expect(error.message).not.toContain(responseBody);
    expect(f.state.sql).toBeNull();
    expect(f.state.builds).toBe(0);
    expect(Object.keys(f.state.services)).toHaveLength(0);
  } finally {
    log.mockRestore();
    f.cleanup();
  }
});

it('identifies gcloud output polluted by an unsupported Python runtime without exposing it', async () => {
  const f = fixture();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const error = await main({
      args: ['--project', 'example-project', '--no-proxy'],
      workspace: f.workspace,
      run: (command, args, options) => {
        const result = f.run(command, args, options);
        return args.slice(0, 3).join(' ') === 'storage buckets get-iam-policy'
          ? `An error occurred: sensitive upstream response\n${result}`
          : result;
      },
      fetch: f.fetch,
    }).catch((error) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('gcloud storage buckets get-iam-policy');
    expect(error.message).toContain('CLOUDSDK_PYTHON');
    expect(error.message).not.toContain('sensitive upstream response');
    expect(f.state.sql).toBeNull();
    expect(f.state.builds).toBe(0);
  } finally {
    log.mockRestore();
    f.cleanup();
  }
});
