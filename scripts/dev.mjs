import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');
const compiled = process.argv.includes('--compiled');
if (compiled) process.env.WEB_ORIGIN ??= 'http://localhost:3000';
execFileSync(process.execPath, ['scripts/setup.mjs'], { stdio: 'inherit' });
const children = [];
let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 800).unref();
};
for (const service of ['audit', 'identity', 'documents', 'signing', 'gateway']) {
  const child = spawn(
    process.execPath,
    compiled
      ? [`dist/services/${service}/index.js`]
      : ['--import', 'tsx', `services/${service}/src/index.ts`],
    {
      stdio: 'inherit',
      env: process.env,
    },
  );
  children.push(child);
  child.on('exit', (code) => {
    if (!stopping) stop(code || 1);
  });
}
if (!process.argv.includes('--api-only')) {
  const child = spawn(
    process.execPath,
    ['node_modules/vite/bin/vite.js', '--config', 'apps/web/vite.config.ts'],
    { stdio: 'inherit', env: process.env },
  );
  children.push(child);
  child.on('exit', (code) => {
    if (!stopping) stop(code || 1);
  });
}
process.once('SIGINT', () => stop());
process.once('SIGTERM', () => stop());
