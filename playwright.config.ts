import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

const localChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const compiled = process.env.PSTON_E2E_BUILT === '1';
const origin = `http://localhost:${compiled ? 4200 : 5273}`;
process.env.PSTON_E2E_DATA_DIR ??= resolve('.local', 'e2e-' + randomUUID());
const serviceEnv = Object.fromEntries(
  ['gateway', 'identity', 'documents', 'signing', 'audit'].flatMap((name, i) => [
    [`${name.toUpperCase()}_PORT`, String(4200 + i)],
    [`${name.toUpperCase()}_URL`, `http://127.0.0.1:${4200 + i}`],
  ]),
);
export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 90000,
  expect: { timeout: 15000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: origin,
    viewport: { width: 1440, height: 1000 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    launchOptions: {
      executablePath:
        process.env.PLAYWRIGHT_CHROMIUM_PATH ?? (existsSync(localChrome) ? localChrome : undefined),
    },
  },
  webServer: {
    command: compiled ? 'node scripts/dev.mjs --compiled --api-only' : 'node scripts/dev.mjs',
    url: origin + '/api/session',
    timeout: 45000,
    reuseExistingServer: false,
    env: {
      ...serviceEnv,
      PSTON_DATA_DIR: process.env.PSTON_E2E_DATA_DIR,
      PSTON_MODE: 'demo',
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      WEB_ORIGIN: origin,
      VITE_PORT: '5273',
    },
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
  },
});
