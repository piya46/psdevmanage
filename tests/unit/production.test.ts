import { it, expect } from 'vitest';
import { validateProduction } from '../../packages/core/src/production.js';
import { createApp } from '../../packages/core/src/http.js';

const env = {
  NODE_ENV: 'production',
  WEB_ORIGIN: 'https://sign.example.test',
  PSTON_MODE: 'google',
  PSTON_STORE: 'postgres',
  PSTON_CLOUD_RUN: 'true',
  PSTON_SIGNING_PROVIDER: 'disabled',
  PSTON_SERVICE_KEY_FILE: '/secrets/key.pem',
  PSTON_PUBLIC_KEYS_FILE: '/secrets/public.json',
  GOOGLE_CLIENT_ID: 'test.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'test-only',
  GOOGLE_ALLOWED_EMAILS: 'owner@gmail.com',
  GOOGLE_REDIRECT_URI: 'https://sign.example.test/api/auth/google/callback',
  PGHOST: '/cloudsql/project:region:db',
  PGDATABASE: 'pston_identity',
  PGUSER: 'pston_identity',
  PGPASSWORD: 'test-only',
  AUDIT_URL: 'https://audit.example.test',
};
it('fails production startup on demo, missing credentials, wrong redirect or unsafe storage', () => {
  expect(() => validateProduction(env, 'identity')).not.toThrow();
  expect(() =>
    validateProduction(
      { ...env, GOOGLE_ALLOWED_EMAILS: undefined, GOOGLE_ALLOWED_SUBS: '123456789012345678901' },
      'identity',
    ),
  ).not.toThrow();
  expect(() =>
    validateProduction(
      { ...env, GOOGLE_ALLOWED_EMAILS: '', GOOGLE_ALLOWED_SUBS: '123456789012345678901' },
      'identity',
    ),
  ).toThrow('GOOGLE_ALLOWED_EMAILS');
  for (const changes of [
    { PSTON_MODE: 'demo' },
    { WEB_ORIGIN: 'http://localhost:5180' },
    { PSTON_STORE: 'sqlite' },
    { PSTON_CLOUD_RUN: 'false' },
    { PSTON_SIGNING_PROVIDER: 'demo' },
    { PSTON_DEMO_KEY_FILE: '/key.pem' },
    { GOOGLE_CLIENT_SECRET: '' },
    { GOOGLE_ALLOWED_EMAILS: '' },
    { GOOGLE_ALLOWED_EMAILS: '*@gmail.com' },
    { GOOGLE_ALLOWED_EMAILS: 'not-an-email' },
    { GOOGLE_REDIRECT_URI: 'https://elsewhere.test/callback' },
    { PGHOST: 'localhost' },
    { PGPASSWORD: '' },
    { AUDIT_URL: 'http://audit.test' },
  ])
    expect(() => validateProduction({ ...env, ...changes }, 'identity')).toThrow();
  expect(() => validateProduction(env, 'documents')).toThrow('PSTON_BLOB_BUCKET');
  expect(() => validateProduction(env, 'gateway')).toThrow('IDENTITY_URL');
});

it('enforces rate limits on routes declared after createApp, while health probes stay available', async () => {
  const app = await createApp('gateway');
  app.get('/limited', { config: { rateLimit: { max: 2, timeWindow: '1 minute' } } }, async () => ({
    ok: true,
  }));
  try {
    expect((await app.inject('/limited')).statusCode).toBe(200);
    expect((await app.inject('/limited')).statusCode).toBe(200);
    expect((await app.inject('/limited')).statusCode).toBe(429);
    expect((await app.inject('/health')).statusCode).toBe(200);
  } finally {
    await app.close();
  }
});
