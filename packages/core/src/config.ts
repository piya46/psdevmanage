import { existsSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { ServiceName } from './types.js';
import { validateProduction } from './production.js';

if (process.env.NODE_ENV !== 'production' && existsSync('.env')) process.loadEnvFile('.env');
export const mode = process.env.PSTON_MODE ?? 'demo';
if (!['demo', 'google'].includes(mode)) throw new Error('PSTON_MODE must be demo or google');
export const production = process.env.NODE_ENV === 'production';
validateProduction(process.env);
export const webOrigin = process.env.WEB_ORIGIN ?? 'http://localhost:5173';
export const rpID = new URL(webOrigin).hostname;
export const secureCookie = new URL(webOrigin).protocol === 'https:';
export const dataRoot = resolve(process.env.PSTON_DATA_DIR ?? '.local');
export const maxPdfBytes = (process.env.PSTON_CLOUD_RUN === 'true' ? 20 : 50) * 1024 * 1024;
if (
  process.env.K_SERVICE &&
  (process.env.PSTON_STORE !== 'postgres' || process.env.PSTON_CLOUD_RUN !== 'true')
)
  throw new Error(
    'Cloud Run requires PostgreSQL and Cloud Run IAM authentication; local storage fallback is disabled',
  );
if (process.env.PSTON_STORE && !['sqlite', 'postgres'].includes(process.env.PSTON_STORE))
  throw new Error('PSTON_STORE must be sqlite or postgres');
export const serviceURLs: Record<ServiceName, string> = {
  gateway: process.env.GATEWAY_URL ?? 'http://127.0.0.1:3000',
  identity: process.env.IDENTITY_URL ?? 'http://127.0.0.1:3001',
  documents: process.env.DOCUMENTS_URL ?? 'http://127.0.0.1:3002',
  signing: process.env.SIGNING_URL ?? 'http://127.0.0.1:3003',
  audit: process.env.AUDIT_URL ?? 'http://127.0.0.1:3004',
};
export function serviceDir(name: ServiceName) {
  const dir = join(dataRoot, 'services', name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
