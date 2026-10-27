import { it, expect, vi, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';

const mocks = vi.hoisted(() => ({ getIdTokenClient: vi.fn() }));
vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    getIdTokenClient = mocks.getIdTokenClient;
  },
}));
vi.mock('../../packages/core/src/security.js', () => ({
  issueToken: async () => 'application-jwt',
  verifyToken: vi.fn(),
  bearer: vi.fn(),
}));
import { rpcResponse } from '../../packages/core/src/http.js';
import { serviceURLs } from '../../packages/core/src/config.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it('uses a Google audience token without replacing the actor-bound application JWT', async () => {
  const previous = serviceURLs.audit;
  serviceURLs.audit = 'https://audit.example.test';
  vi.stubEnv('PSTON_CLOUD_RUN', 'true');
  mocks.getIdTokenClient.mockResolvedValue({
    getRequestHeaders: async () => new Headers({ authorization: 'Bearer google-id-token' }),
  });
  const request = vi.fn(async () => new Response('{}'));
  vi.stubGlobal('fetch', request);
  try {
    await rpcResponse('documents', 'audit', '/events', {
      method: 'POST',
      body: { id: 'one' },
      actor: 'owner',
    });
    await rpcResponse('documents', 'audit', '/events', {
      method: 'POST',
      body: { id: 'two' },
      actor: 'owner',
    });
    expect(mocks.getIdTokenClient).toHaveBeenCalledExactlyOnceWith('https://audit.example.test');
    expect(request.mock.calls[0]).toMatchObject([
      'https://audit.example.test/events',
      {
        headers: {
          authorization: 'Bearer application-jwt',
          'X-Serverless-Authorization': 'Bearer google-id-token',
        },
      },
    ]);
  } finally {
    serviceURLs.audit = previous;
  }
});
it('refuses ephemeral database fallback and missing database credentials on Cloud Run', () => {
  for (const [store, cloud, error] of [
    ['sqlite', 'false', 'fallback is disabled'],
    ['postgres', 'true', 'credentials and socket'],
  ]) {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        "import {Store} from './packages/core/src/store.ts'; await Store.open('identity');",
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          K_SERVICE: 'pston-test',
          PSTON_STORE: store,
          PSTON_CLOUD_RUN: cloud,
          PGHOST: '',
          PGDATABASE: '',
          PGUSER: '',
          PGPASSWORD: '',
        },
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(error);
  }
});
