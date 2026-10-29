import { lstatSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseEnv } from 'node:util';
import { readGoogleAllowlist } from '../../packages/core/src/google-allowlist.mjs';

const deploymentKeys = new Set([
  'PSTON_GCP_PROJECT',
  'PSTON_GCP_REGION',
  'PSTON_GCP_NAME',
  'PSTON_DEPLOY_ENVIRONMENT',
  'WEB_ORIGIN',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_ALLOWED_SUBS',
  'GOOGLE_ALLOWED_EMAILS',
  'PSTON_SIGNING_PROVIDER',
]);
export function deploymentEnv(args, root, env = process.env) {
  const index = args.indexOf('--env-file');
  if (index === -1) return env;
  const path = args[index + 1];
  if (!path || path.startsWith('--')) throw new Error('Missing value for --env-file');
  const full = path.startsWith('/') ? path : join(root, path);
  const stat = lstatSync(full);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error('Deployment env must be a regular file');
  if (process.platform !== 'win32' && stat.mode & 0o077)
    throw new Error('Protect the deployment env file with chmod 600 before deploying');
  const values = parseEnv(readFileSync(full, 'utf8'));
  for (const key of Object.keys(values))
    if (!deploymentKeys.has(key)) throw new Error(`Unsupported deployment env key: ${key}`);
  return { ...env, ...values };
}

export const services = ['gateway', 'identity', 'documents', 'signing', 'audit'];

// IAM bindings and new revisions can take a short time to become usable.
// Retry only read-only startup probes; never repeat provisioning or login actions.
export async function fetchDeploymentJSON(
  url,
  {
    headers,
    fetch = globalThis.fetch,
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    attempts = 12,
  } = {},
) {
  let last = 'network unavailable';
  for (let attempt = 0; attempt < attempts; attempt++) {
    let response;
    try {
      response = await fetch(url, {
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      });
    } catch (error) {
      if (!(error instanceof TypeError) && error.name !== 'TimeoutError') throw error;
      last = 'network unavailable';
    }
    if (response?.ok) {
      try {
        return await response.json();
      } catch {
        throw new Error(`Deployment check ${new URL(url).pathname} returned invalid JSON`);
      }
    }
    if (response) {
      last = `HTTP ${response.status}`;
      await response.body?.cancel();
      if (![403, 408, 429, 500, 502, 503, 504].includes(response.status))
        throw new Error(`Deployment check ${new URL(url).pathname} failed (${last})`);
    }
    if (attempt + 1 < attempts) await wait(5000);
  }
  throw new Error(`Deployment check ${new URL(url).pathname} did not become ready (${last})`);
}

const sourceRoots = [
  'Dockerfile',
  '.dockerignore',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'apps',
  'packages',
  'services',
  'scripts',
  'assets',
  'infra/gcp',
];
const excludedDirectories = new Set([
  'node_modules',
  'dist',
  '.git',
  '.local',
  '.codex',
  '.agents',
  '.aws',
  'coverage',
  'test-results',
  'playwright-report',
]);

export function parseOptions(args, env = process.env) {
  const values = {
    project: env.PSTON_GCP_PROJECT ?? '',
    region: env.PSTON_GCP_REGION ?? 'asia-southeast1',
    name: env.PSTON_GCP_NAME ?? 'pston-dev',
    port: '5180',
    mode: 'deploy',
    dryRun: false,
    proxy: true,
    environment: env.PSTON_DEPLOY_ENVIRONMENT ?? 'demo',
  };
  const names = {
    '--project': 'project',
    '--region': 'region',
    '--name': 'name',
    '--port': 'port',
    '--environment': 'environment',
    '--env-file': 'envFile',
  };
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--help' || key === '-h') return { ...values, help: true };
    if (key === '--dry-run') values.dryRun = true;
    else if (key === '--no-proxy') values.proxy = false;
    else if (key === '--connect') values.mode = 'connect';
    else if (names[key]) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
      values[names[key]] = value;
    } else throw new Error(`Unknown argument: ${key}`);
  }
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(values.project))
    throw new Error(
      'Specify --project YOUR_PROJECT_ID; the active gcloud project is never selected automatically',
    );
  if (!/^[a-z]+-[a-z]+[0-9]+$/.test(values.region)) throw new Error('Invalid --region');
  if (!/^[a-z][a-z0-9-]{1,13}[a-z0-9]$/.test(values.name))
    throw new Error('--name must be 3–15 lowercase letters, digits or hyphens');
  if (!/^\d+$/.test(values.port) || Number(values.port) < 1024 || Number(values.port) > 65535)
    throw new Error('--port must be 1024–65535');
  if (!['demo', 'production'].includes(values.environment))
    throw new Error('Environment must be demo or production');
  if (values.environment === 'production') {
    const signingProvider = env.PSTON_SIGNING_PROVIDER ?? 'disabled';
    if (!['disabled', 'google-cloud-hsm'].includes(signingProvider))
      throw new Error('Production PSTON_SIGNING_PROVIDER must be disabled or google-cloud-hsm');
    if (!args.includes('--name') && !env.PSTON_GCP_NAME) values.name = 'pston-prod';
    if (values.mode === 'connect')
      throw new Error('Production uses the HTTPS browser origin, not --connect');
    let url;
    try {
      url = new URL(env.WEB_ORIGIN);
    } catch {
      throw new Error('Set WEB_ORIGIN to the production HTTPS origin');
    }
    if (
      url.protocol !== 'https:' ||
      url.origin !== env.WEB_ORIGIN ||
      url.username ||
      url.password ||
      url.hostname === 'localhost'
    )
      throw new Error('WEB_ORIGIN must be an HTTPS origin without a path or trailing slash');
    if (!/^[a-zA-Z0-9-]+\.apps\.googleusercontent\.com$/.test(env.GOOGLE_CLIENT_ID ?? ''))
      throw new Error('Set GOOGLE_CLIENT_ID to a Google OAuth Web Client ID');
    if (!env.GOOGLE_CLIENT_SECRET?.trim() || /[\r\n]/.test(env.GOOGLE_CLIENT_SECRET))
      throw new Error(
        'Set GOOGLE_CLIENT_SECRET locally; do not supply secrets as command arguments',
      );
    const allowlist = readGoogleAllowlist(env);
    if (!allowlist.emails.length && !allowlist.subjects.length)
      throw new Error('Set GOOGLE_ALLOWED_EMAILS to the Google accounts allowed to use PSTON');
    return {
      ...values,
      port: Number(values.port),
      proxy: false,
      origin: url.origin,
      signingProvider,
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        allowedEmails: allowlist.emails.join(','),
        allowedSubs: allowlist.subjects.join(','),
      },
    };
  }
  return { ...values, port: Number(values.port), origin: `http://localhost:${values.port}` };
}

export function sourceFiles(root) {
  const files = [];
  function visit(path) {
    const name = path.split('/').at(-1);
    if (
      excludedDirectories.has(name) ||
      name.startsWith('.env') ||
      /\.(pem|key|p12|pfx|cer|crt|der|sqlite(?:-wal|-shm)?|db|pdf|docx|xlsx|log|tgz|tar|gz|zip)$/i.test(
        name,
      )
    )
      return;
    const full = join(root, path),
      stat = lstatSync(full);
    if (stat.isSymbolicLink()) throw new Error(`Source symlink rejected: ${path}`);
    if (stat.isDirectory()) for (const child of readdirSync(full).sort()) visit(`${path}/${child}`);
    else if (stat.isFile()) {
      if (name.endsWith('.json')) {
        const content = readFileSync(full, 'utf8');
        if (/"(?:private_key|client_secret|refresh_token)"\s*:\s*"[^"\s]/.test(content))
          throw new Error(
            `Possible credentials in source JSON: ${path}. Move credentials outside the source tree.`,
          );
      }
      files.push(relative(root, full).replaceAll('\\', '/'));
    }
  }
  for (const path of sourceRoots) {
    if (!existsSync(join(root, path))) throw new Error(`Missing source: ${path}`);
    visit(path);
  }
  return files.sort();
}

export function assertOwned(resource, config, label) {
  if (
    resource.labels?.['pston-managed'] !== 'cloud-run' ||
    resource.labels?.['pston-app'] !== config.name ||
    (resource.labels?.['pston-environment'] ?? 'demo') !== (config.environment ?? 'demo')
  )
    throw new Error(
      `${label} already exists and is not owned by this PSTON deployment; choose a different --name`,
    );
}
export function assertGatewayPolicy(policy, label) {
  for (const binding of policy.bindings ?? [])
    for (const member of binding.members ?? [])
      if (
        member === 'allAuthenticatedUsers' ||
        (member === 'allUsers' && (binding.role !== 'roles/run.invoker' || binding.condition))
      )
        throw new Error(`${label} has unexpected public IAM access`);
}
export function assertPrivatePolicy(policy, label) {
  if (
    policy.bindings?.some((binding) =>
      binding.members?.some((member) => ['allUsers', 'allAuthenticatedUsers'].includes(member)),
    )
  )
    throw new Error(
      `${label} has public IAM access; remove it explicitly before deploying the demo`,
    );
}
export function invocationGraph() {
  return {
    gateway: [],
    identity: ['gateway', 'scheduler'],
    documents: ['gateway', 'signing', 'scheduler'],
    signing: ['gateway', 'scheduler'],
    audit: ['gateway', 'identity', 'documents', 'signing'],
  };
}
