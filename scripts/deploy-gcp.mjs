import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, createPublicKey, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import {
  parseOptions,
  sourceFiles,
  services,
  assertOwned,
  assertPrivatePolicy,
  invocationGraph,
  deploymentEnv,
  assertGatewayPolicy,
} from './lib/gcp-deploy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const help = `Deploy PSTON as five Cloud Run services + Cloud SQL PostgreSQL + Cloud Storage.

  npm run deploy:gcp -- --project YOUR_PROJECT_ID
  npm run deploy:gcp -- --environment production --env-file .env.production

Requirements: Node.js 22, gcloud, openssl; an existing project with Billing enabled
and an operator allowed to create resources and manage their IAM policies.
The first run creates billable resources. Cloud SQL remains billed when idle.
The default is a private TEST signing environment. Production uses a public HTTPS
gateway with Google allowlist and HA SQL; TDID signing remains disabled.

  --region REGION   Default: asia-southeast1 (Singapore)
  --environment ENV demo (default) or production (Google login; TDID signing disabled)
  --env-file FILE   Read allowlisted deploy values locally; chmod 600 required
  --name NAME       Default: pston-dev / pston-prod; use the same value for updates
  --port PORT       Default: 5180; browser origin and authenticated local proxy
  --dry-run         Show resources/source files without calling Google Cloud
  --no-proxy        Deploy and exit without opening the local proxy
  --connect         Reconnect to an existing deployment (same port as deployment)
  --help            Show this help

No local Docker daemon is needed. Build runs in Cloud Build. Databases, PDF objects
and secrets are reused on repeat runs. Local SQLite/PDF data is not uploaded.
See docs/deploy-gcp.md for permissions, costs, recovery and production prerequisites.`;

function executeCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw new Error(`${command}: ${result.error.message}`);
  if (result.status !== 0) {
    const error = new Error(
      `${command} ${args.slice(0, 3).join(' ')} failed (exit ${result.status}).`,
    );
    error.detail = result.stderr ?? '';
    throw error;
  }
  return result.stdout?.trim() ?? '';
}

export async function main({
  args = process.argv.slice(2),
  run = executeCommand,
  fetch = globalThis.fetch,
  workspace = root,
} = {}) {
  const root = workspace;
  const config = parseOptions(
    args,
    args.includes('--help') || args.includes('-h') ? process.env : deploymentEnv(args, root),
  );
  if (config.help) {
    console.log(help);
    return;
  }
  const { project, region, name, origin, port } = config;
  const production = config.environment === 'production';
  const files = sourceFiles(root);
  if (config.dryRun) {
    console.log(
      JSON.stringify(
        {
          mutations: false,
          project,
          region,
          services: services.map((s) => `${name}-${s}`),
          cloudSQL: {
            name: `${name}-sql`,
            version: 'POSTGRES_17',
            tier: production ? 'db-custom-2-7680' : 'db-custom-1-3840',
            availability: production ? 'REGIONAL' : 'ZONAL',
            storageGiB: production ? 50 : 10,
          },
          buckets: ['documents', 'signing', 'builds'],
          environment: config.environment,
          access: production
            ? 'public HTTPS gateway + Google allowlist; four private services'
            : 'private Google IAM + local Cloud Run proxy',
          signing: production
            ? 'disabled pending TDID HSM integration and acceptance'
            : 'test certificate only',
          origin,
          sourceFiles: files,
          note: 'Cloud SQL, storage, builds and requests incur charges; no cloud calls made.',
        },
        null,
        2,
      ),
    );
    return;
  }
  if (Number(process.versions.node.split('.')[0]) !== 22)
    throw new Error('Use Node.js 22 for this deployment script.');
  run('openssl', ['version']);
  const gc = (args, options) => run('gcloud', [...args, '--project', project, '--quiet'], options);
  const json = (args) => {
    const output = gc([...args, '--format=json']);
    try {
      return JSON.parse(output);
    } catch {
      throw new Error(
        `gcloud ${args.slice(0, 3).join(' ')} did not return valid JSON. Check gcloud and its Python interpreter; use a supported Python version via CLOUDSDK_PYTHON.`,
      );
    }
  };
  const mutate = (args, options) => gc([...args, '--format=none'], options);
  const optional = (args) => {
    try {
      return json(args);
    } catch (error) {
      if (/PERMISSION_DENIED|UNAUTHENTICATED|permission denied/i.test(error.detail)) throw error;
      if (/NOT_FOUND|was not found|does not exist/i.test(error.detail)) return null;
      throw error;
    }
  };
  if (config.proxy)
    await new Promise((resolve, reject) => {
      const server = createServer();
      server.once('error', () =>
        reject(new Error(`Port ${port} is busy; stop its listener or use --port.`)),
      );
      server.listen(port, '127.0.0.1', () => server.close(resolve));
    });
  let accounts = json(['auth', 'list', '--filter=status:ACTIVE']);
  if (!accounts.length && process.stdin.isTTY) {
    gc(['auth', 'login'], { stdio: 'inherit' });
    accounts = json(['auth', 'list', '--filter=status:ACTIVE']);
  }
  if (accounts.length !== 1 || accounts[0].account.endsWith('.gserviceaccount.com'))
    throw new Error('Run gcloud auth login with the intended operator account first.');
  const operator = `user:${accounts[0].account}`;
  const serviceName = (s) => `${name}-${s}`;
  const sa = (s) => `${name}-${s}@${project}.iam.gserviceaccount.com`;
  const labels = {
    'pston-managed': 'cloud-run',
    'pston-app': name,
    'pston-environment': config.environment,
  };
  const labelFlag = Object.entries(labels)
    .map(([k, v]) => `${k}=${v}`)
    .join(',');
  const marker = `PSTON Cloud Run deployment: ${name}`;
  const regionFlags = ['--region', region];
  const runDescribe = (s) => json(['run', 'services', 'describe', serviceName(s), ...regionFlags]);
  const verifyRun = (resource) =>
    assertOwned({ labels: resource.metadata?.labels }, config, 'Cloud Run service');
  const verifyPolicy = (policy, service) =>
    production && service === 'gateway'
      ? assertGatewayPolicy(policy, service)
      : assertPrivatePolicy(policy, service);
  if (config.mode === 'connect') {
    const existing = runDescribe('gateway');
    verifyRun(existing);
    assertPrivatePolicy(
      json(['run', 'services', 'get-iam-policy', serviceName('gateway'), ...regionFlags]),
      'Gateway',
    );
    const env = existing.spec.template.spec.containers[0].env;
    if (env.find((v) => v.name === 'WEB_ORIGIN')?.value !== origin)
      throw new Error('Use the same --port as the deployment, or redeploy to change WEB_ORIGIN.');
    await proxy();
    return;
  }
  const projectInfo = json(['projects', 'describe', project]);
  assertPrivatePolicy(json(['projects', 'get-iam-policy', project]), 'Project');
  if (projectInfo.lifecycleState !== 'ACTIVE') throw new Error('Project is not ACTIVE');
  const billing = json(['billing', 'projects', 'describe', project]);
  if (!billing.billingEnabled)
    throw new Error(
      `Billing is not enabled for project ${project}.\n` +
        (billing.billingAccountName
          ? 'A billing account is linked, but billing is disabled. Check that account in Cloud Billing.\n'
          : 'No billing account is linked to this project.\n') +
        `Open https://console.cloud.google.com/billing/linkedaccount?project=${encodeURIComponent(project)}\n` +
        'Select an active billing account, then rerun the same deploy command. No resources were created by this run.',
    );
  console.log(
    `Deploying ${config.environment} into ${project} / ${region}: 5 Cloud Run services, ${production ? 'regional HA' : 'zonal'} Cloud SQL and private buckets. These resources incur charges.`,
  );
  mutate(
    [
      'services',
      'enable',
      ...[
        'run',
        'sqladmin',
        'artifactregistry',
        'cloudbuild',
        'secretmanager',
        'storage',
        'iam',
        'cloudscheduler',
        'logging',
      ].map((s) => `${s}.googleapis.com`),
    ],
    { stdio: 'inherit' },
  );
  let accessToken,
    tokenAt = 0;
  async function api(url, method = 'GET', body, allowMissing = false) {
    if (!accessToken || Date.now() - tokenAt > 600000) {
      accessToken = gc(['auth', 'print-access-token']);
      tokenAt = Date.now();
    }
    const response = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });
    if (allowMissing && response.status === 404) return null;
    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error(
        `Google API ${method} ${new URL(url).hostname}${new URL(url).pathname}: HTTP ${response.status}; response was not valid JSON. Check the API status and network connection, then rerun.`,
      );
    }
    if (!response.ok)
      throw new Error(
        `Google API ${method} ${new URL(url).pathname}: HTTP ${response.status} (${result.error?.status ?? 'request failed'}). Check operator permissions and enabled APIs.`,
      );
    return result;
  }
  const sqlBase = `https://sqladmin.googleapis.com/sql/v1beta4/projects/${project}`;
  async function waitSQL(operation) {
    for (let attempt = 0; attempt < 240; attempt++) {
      const status = await api(`${sqlBase}/operations/${operation.name}`);
      if (status.status === 'DONE') {
        if (status.error)
          throw new Error(
            `Cloud SQL operation failed: ${status.error.errors?.map((e) => e.code).join(', ')}`,
          );
        return;
      }
      if (attempt % 6 === 0) console.log('Waiting for Cloud SQL operation…');
      await sleep(5000);
    }
    throw new Error(
      'Cloud SQL operation has not finished; check the console and rerun after it completes.',
    );
  }
  const grantProject = (account, role) =>
    mutate([
      'projects',
      'add-iam-policy-binding',
      project,
      `--member=serviceAccount:${account}`,
      `--role=${role}`,
      '--condition=None',
    ]);
  for (const identity of [...services, 'build', 'init', 'scheduler']) {
    const existing = optional(['iam', 'service-accounts', 'describe', sa(identity)]);
    if (existing && existing.description !== marker)
      throw new Error(`Service account ${sa(identity)} belongs to another deployment`);
    if (!existing)
      mutate([
        'iam',
        'service-accounts',
        'create',
        serviceName(identity),
        `--description=${marker}`,
        `--display-name=PSTON ${identity}`,
      ]);
  }
  const repo = optional(['artifacts', 'repositories', 'describe', name, '--location', region]);
  if (repo) assertOwned(repo, config, 'Artifact Registry');
  else
    mutate([
      'artifacts',
      'repositories',
      'create',
      name,
      '--location',
      region,
      '--repository-format=docker',
      `--labels=${labelFlag}`,
    ]);
  mutate([
    'artifacts',
    'repositories',
    'add-iam-policy-binding',
    name,
    '--location',
    region,
    `--member=serviceAccount:${sa('build')}`,
    '--role=roles/artifactregistry.writer',
    '--condition=None',
  ]);
  grantProject(sa('build'), 'roles/logging.logWriter');
  const buckets = {};
  for (const kind of ['documents', 'signing', 'builds']) {
    const bucket = `${project}-${name}-${kind}`;
    const existing = await api(
      `https://storage.googleapis.com/storage/v1/b/${bucket}`,
      'GET',
      undefined,
      true,
    );
    if (existing) {
      assertOwned(existing, config, 'Storage bucket');
      if (
        existing.location.toLowerCase() !== region ||
        !existing.iamConfiguration?.uniformBucketLevelAccess?.enabled ||
        existing.iamConfiguration?.publicAccessPrevention !== 'enforced'
      )
        throw new Error(`Bucket ${bucket} security/location differs; review it before rerunning`);
    } else
      await api(`https://storage.googleapis.com/storage/v1/b?project=${project}`, 'POST', {
        name: bucket,
        location: region,
        labels,
        iamConfiguration: {
          uniformBucketLevelAccess: { enabled: true },
          publicAccessPrevention: 'enforced',
        },
        versioning: { enabled: kind !== 'builds' },
        softDeletePolicy: { retentionDurationSeconds: '604800' },
        ...(kind === 'builds'
          ? { lifecycle: { rule: [{ action: { type: 'Delete' }, condition: { age: 7 } }] } }
          : {}),
      });
    buckets[kind] = bucket;
    assertPrivatePolicy(
      json(['storage', 'buckets', 'get-iam-policy', `gs://${bucket}`]),
      'Storage bucket',
    );
    const account = kind === 'builds' ? sa('build') : sa(kind);
    const roles =
      kind === 'builds'
        ? ['roles/storage.objectViewer']
        : ['roles/storage.objectCreator', 'roles/storage.objectViewer'];
    for (const role of roles)
      mutate([
        'storage',
        'buckets',
        'add-iam-policy-binding',
        `gs://${bucket}`,
        `--member=serviceAccount:${account}`,
        `--role=${role}`,
      ]);
  }
  const secretCache = new Map();
  async function secret(suffix, generate, expectedValue) {
    const id = `${name}-${suffix}`;
    if (secretCache.has(id)) return secretCache.get(id);
    const existing = optional(['secrets', 'describe', id]);
    if (existing) assertOwned(existing, config, 'Secret');
    else
      mutate([
        'secrets',
        'create',
        id,
        '--replication-policy=user-managed',
        '--locations',
        region,
        `--labels=${labelFlag}`,
      ]);
    let versions = json([
      'secrets',
      'versions',
      'list',
      id,
      '--filter=state=ENABLED',
      '--sort-by=~createTime',
      '--limit=1',
    ]);
    if (!versions.length) {
      mutate(['secrets', 'versions', 'add', id, '--data-file=-'], { input: await generate() });
      versions = json([
        'secrets',
        'versions',
        'list',
        id,
        '--filter=state=ENABLED',
        '--sort-by=~createTime',
        '--limit=1',
      ]);
    }
    if (!versions.length) throw new Error(`Secret ${id} has no enabled version`);
    let version = versions[0].name.split('/').at(-1);
    let value = gc(['secrets', 'versions', 'access', version, '--secret', id]);
    if (expectedValue !== undefined && value !== expectedValue) {
      mutate(['secrets', 'versions', 'add', id, '--data-file=-'], { input: expectedValue });
      versions = json([
        'secrets',
        'versions',
        'list',
        id,
        '--filter=state=ENABLED',
        '--sort-by=~createTime',
        '--limit=1',
      ]);
      version = versions[0].name.split('/').at(-1);
      value = gc(['secrets', 'versions', 'access', version, '--secret', id]);
      if (value !== expectedValue) throw new Error('Secret rotation verification failed');
    }
    assertPrivatePolicy(json(['secrets', 'get-iam-policy', id]), 'Secret');
    const result = { id, version, value, ref: `${id}:${version}` };
    secretCache.set(id, result);
    return result;
  }
  const allowSecret = (item, identity) =>
    mutate([
      'secrets',
      'add-iam-policy-binding',
      item.id,
      `--member=serviceAccount:${sa(identity)}`,
      '--role=roles/secretmanager.secretAccessor',
      '--condition=None',
    ]);
  const keys = {},
    publicKeys = {};
  const oauthSecret = production
    ? await secret(
        'google-client-secret',
        () => config.google.clientSecret,
        config.google.clientSecret,
      )
    : null;
  if (oauthSecret) allowSecret(oauthSecret, 'identity');
  for (const service of services) {
    keys[service] = await secret(
      `${service}-key`,
      () =>
        generateKeyPairSync('ed25519', {
          privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
          publicKeyEncoding: { type: 'spki', format: 'pem' },
        }).privateKey,
    );
    publicKeys[service] = createPublicKey(keys[service].value).export({
      type: 'spki',
      format: 'pem',
    });
    allowSecret(keys[service], service);
  }
  const pub = await secret('public-keys', () => JSON.stringify(publicKeys));
  if (JSON.stringify(JSON.parse(pub.value)) !== JSON.stringify(publicKeys))
    throw new Error(
      'Public/private identity keys differ; restore matching Secret Manager versions before deploying.',
    );
  for (const service of services) allowSecret(pub, service);
  const bootstrap = await secret('db-bootstrap', () =>
    JSON.stringify(
      Object.fromEntries(
        ['postgres', 'identity', 'documents', 'signing', 'audit'].map((s) => [
          s,
          randomBytes(48).toString('base64url'),
        ]),
      ),
    ),
  );
  const passwords = JSON.parse(bootstrap.value),
    dbSecrets = {};
  for (const service of services.filter((s) => s !== 'gateway')) {
    dbSecrets[service] = await secret(`${service}-db`, () => passwords[service]);
    if (dbSecrets[service].value !== passwords[service])
      throw new Error(
        'Database credentials differ from bootstrap; resolve credential rotation before redeploying.',
      );
    allowSecret(dbSecrets[service], service);
    grantProject(sa(service), 'roles/cloudsql.client');
  }
  grantProject(sa('init'), 'roles/cloudsql.client');
  allowSecret(bootstrap, 'init');
  const sqlName = `${name}-sql`;
  let instance = await api(`${sqlBase}/instances/${sqlName}`, 'GET', undefined, true);
  if (instance) {
    assertOwned({ labels: instance.settings.userLabels }, config, 'Cloud SQL');
    if (
      instance.region !== region ||
      instance.databaseVersion !== 'POSTGRES_17' ||
      instance.settings.ipConfiguration?.authorizedNetworks?.length ||
      instance.settings.connectorEnforcement !== 'REQUIRED'
    )
      throw new Error(
        'Existing Cloud SQL region/version/access differs; review it before deploying.',
      );
    if (
      production &&
      (instance.settings.availabilityType !== 'REGIONAL' ||
        !instance.settings.deletionProtectionEnabled ||
        !instance.settings.backupConfiguration?.enabled ||
        !instance.settings.backupConfiguration?.pointInTimeRecoveryEnabled ||
        (instance.settings.backupConfiguration?.backupRetentionSettings?.retainedBackups ?? 0) <
          30 ||
        (instance.settings.backupConfiguration?.transactionLogRetentionDays ?? 0) < 7 ||
        instance.settings.ipConfiguration?.sslMode !== 'ENCRYPTED_ONLY')
    )
      throw new Error(
        'Production Cloud SQL requires HA, deletion protection, PITR and 30 backups; review configuration drift',
      );
    if (instance.state !== 'RUNNABLE')
      throw new Error('Cloud SQL is not RUNNABLE yet; wait for its current operation to finish.');
  } else {
    console.log('Creating Cloud SQL PostgreSQL (this can take several minutes)…');
    const operation = await api(`${sqlBase}/instances`, 'POST', {
      name: sqlName,
      region,
      databaseVersion: 'POSTGRES_17',
      rootPassword: passwords.postgres,
      settings: {
        edition: 'ENTERPRISE',
        tier: production ? 'db-custom-2-7680' : 'db-custom-1-3840',
        availabilityType: production ? 'REGIONAL' : 'ZONAL',
        dataDiskType: 'PD_SSD',
        dataDiskSizeGb: production ? '50' : '10',
        storageAutoResize: true,
        storageAutoResizeLimit: '100',
        activationPolicy: 'ALWAYS',
        deletionProtectionEnabled: true,
        userLabels: labels,
        connectorEnforcement: 'REQUIRED',
        ipConfiguration: { ipv4Enabled: true, authorizedNetworks: [], sslMode: 'ENCRYPTED_ONLY' },
        backupConfiguration: {
          enabled: true,
          startTime: '20:00',
          pointInTimeRecoveryEnabled: true,
          transactionLogRetentionDays: 7,
          backupRetentionSettings: { retainedBackups: production ? 30 : 7, retentionUnit: 'COUNT' },
        },
      },
    });
    await waitSQL(operation);
    instance = await api(`${sqlBase}/instances/${sqlName}`);
  }
  const work = mkdtempSync(join(tmpdir(), 'pston-cloud-run-'));
  try {
    // Cert material never enters the source staging directory or build image.
    let generatedDemo, certSecret, keySecret;
    if (!production) {
      const demoBundle = await secret('demo-identity', () => {
        run('openssl', [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-sha256',
          '-nodes',
          '-keyout',
          join(work, 'key.pem'),
          '-out',
          join(work, 'cert.pem'),
          '-days',
          '365',
          '-subj',
          '/CN=PSTON TEST ONLY - NOT TDID/O=PSTON Development/C=TH',
          '-addext',
          'keyUsage=digitalSignature',
          '-addext',
          'basicConstraints=critical,CA:FALSE',
        ]);
        generatedDemo = {
          key: readFileSync(join(work, 'key.pem'), 'utf8'),
          cert: readFileSync(join(work, 'cert.pem'), 'utf8'),
        };
        return JSON.stringify(generatedDemo);
      });
      const demo = JSON.parse(demoBundle.value);
      certSecret = await secret('demo-cert', () => demo.cert);
      keySecret = await secret('demo-key', () => demo.key);
      if (certSecret.value !== demo.cert.trim() || keySecret.value !== demo.key.trim())
        throw new Error('Demo identity secret versions do not match');
      allowSecret(certSecret, 'signing');
      allowSecret(keySecret, 'signing');
    }
    const stage = join(work, 'source');
    mkdirSync(stage);
    for (const file of files) {
      const dest = join(stage, file);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(join(root, file), dest);
    }
    const release =
      new Date().toISOString().replace(/[^0-9]/g, '') + '-' + randomBytes(3).toString('hex');
    const image = `${region}-docker.pkg.dev/${project}/${name}/app:${release}`;
    const buildConfig = join(root, 'infra/gcp/cloudbuild.json');
    console.log('Building container image in Cloud Build…');
    gc(
      [
        'builds',
        'submit',
        stage,
        '--config',
        buildConfig,
        `--substitutions=_IMAGE=${image}`,
        ...regionFlags,
        '--service-account',
        `projects/${project}/serviceAccounts/${sa('build')}`,
        '--gcs-source-staging-dir',
        `gs://${buckets.builds}/source`,
      ],
      { stdio: 'inherit' },
    );
    const commonEnv = {
      HOST: '0.0.0.0',
      NODE_ENV: production ? 'production' : 'development',
      PSTON_MODE: production ? 'google' : 'demo',
      PSTON_SIGNING_PROVIDER: production ? 'disabled' : 'demo',
      PSTON_RELEASE: release,
      PSTON_DATA_DIR: '/tmp/pston',
      PSTON_CLOUD_RUN: 'true',
      PSTON_STORE: 'postgres',
      WEB_ORIGIN: origin,
      PGHOST: `/cloudsql/${instance.connectionName}`,
      PSTON_SERVICE_KEY_FILE: '/secrets/identity/private.pem',
      PSTON_PUBLIC_KEYS_FILE: '/secrets/public/keys.json',
    };
    const initEnv = join(work, 'init-env.json');
    writeFileSync(
      initEnv,
      JSON.stringify({
        PGHOST: commonEnv.PGHOST,
        PSTON_DB_BOOTSTRAP_FILE: '/secrets/bootstrap/data.json',
      }),
    );
    const initJob = `${name}-init-db`;
    const oldJob = optional(['run', 'jobs', 'describe', initJob, ...regionFlags]);
    if (oldJob) assertOwned({ labels: oldJob.metadata?.labels }, config, 'Database init job');
    gc(
      [
        'run',
        'jobs',
        'deploy',
        initJob,
        ...regionFlags,
        '--image',
        image,
        '--service-account',
        sa('init'),
        '--set-cloudsql-instances',
        instance.connectionName,
        '--command=node',
        '--args=scripts/init-cloud-db.mjs',
        '--env-vars-file',
        initEnv,
        `--set-secrets=/secrets/bootstrap/data.json=${bootstrap.ref}`,
        '--tasks=1',
        '--max-retries=0',
        '--task-timeout=300s',
        `--labels=${labelFlag}`,
      ],
      { stdio: 'inherit' },
    );
    gc(['run', 'jobs', 'execute', initJob, ...regionFlags, '--wait'], { stdio: 'inherit' });
    // Keep no deployed job with administrator credentials after initialization.
    mutate(['run', 'jobs', 'delete', initJob, ...regionFlags]);
    const urls = {};
    for (const service of ['audit', 'documents', 'identity', 'signing', 'gateway']) {
      const old = optional(['run', 'services', 'describe', serviceName(service), ...regionFlags]);
      if (old) {
        verifyRun(old);
        verifyPolicy(
          json(['run', 'services', 'get-iam-policy', serviceName(service), ...regionFlags]),
          service,
        );
        if (old.metadata?.annotations?.['run.googleapis.com/invoker-iam-disabled'] === 'true')
          throw new Error(
            `${service}: IAM invoker check is disabled; re-enable it before deploying the demo`,
          );
      }
      const env = {
        ...commonEnv,
        ...Object.fromEntries(
          Object.entries(urls).map(([s, url]) => [`${s.toUpperCase()}_URL`, url]),
        ),
      };
      const secrets = [
        `/secrets/identity/private.pem=${keys[service].ref}`,
        `/secrets/public/keys.json=${pub.ref}`,
      ];
      if (service !== 'gateway') {
        env.PGUSER = `pston_${service}`;
        env.PGDATABASE = `pston_${service}`;
        secrets.push(`PGPASSWORD=${dbSecrets[service].ref}`);
      }
      if (buckets[service]) env.PSTON_BLOB_BUCKET = buckets[service];
      if (service === 'identity' && production) {
        env.GOOGLE_CLIENT_ID = config.google.clientId;
        if (config.google.allowedEmails) env.GOOGLE_ALLOWED_EMAILS = config.google.allowedEmails;
        else env.GOOGLE_ALLOWED_SUBS = config.google.allowedSubs;
        env.GOOGLE_REDIRECT_URI = `${origin}/api/auth/google/callback`;
        secrets.push(`GOOGLE_CLIENT_SECRET=${oauthSecret.ref}`);
      }
      if (service === 'signing' && !production) {
        env.PSTON_DEMO_CERT_FILE = '/secrets/demo-cert/cert.pem';
        env.PSTON_DEMO_KEY_FILE = '/secrets/demo-key/key.pem';
        secrets.push(
          `/secrets/demo-cert/cert.pem=${certSecret.ref}`,
          `/secrets/demo-key/key.pem=${keySecret.ref}`,
        );
      }
      const envFile = join(work, `${service}-env.json`);
      writeFileSync(envFile, JSON.stringify(env), { mode: 0o600 });
      console.log(`Deploying ${service}…`);
      gc(
        [
          'run',
          'deploy',
          serviceName(service),
          ...regionFlags,
          '--image',
          image,
          '--service-account',
          sa(service),
          '--execution-environment=gen2',
          '--port=8080',
          '--command=node',
          `--args=dist/services/${service}/index.js`,
          '--env-vars-file',
          envFile,
          `--set-secrets=${secrets.join(',')}`,
          ...(service === 'gateway' ? [] : ['--set-cloudsql-instances', instance.connectionName]),
          // Preserve a previously verified production gateway's public binding on updates.
          ...(production && service === 'gateway' && old ? [] : ['--no-allow-unauthenticated']),
          '--invoker-iam-check',
          '--ingress=all',
          '--min=0',
          '--max=2',
          `--concurrency=${['documents', 'signing'].includes(service) ? 2 : 8}`,
          '--cpu=1',
          `--memory=${service === 'documents' ? '2Gi' : ['gateway', 'signing'].includes(service) ? '1Gi' : '512Mi'}`,
          '--timeout=300s',
          '--cpu-throttling',
          `--labels=${labelFlag}`,
        ],
        { stdio: 'inherit' },
      );
      for (const caller of invocationGraph()[service])
        mutate([
          'run',
          'services',
          'add-iam-policy-binding',
          serviceName(service),
          ...regionFlags,
          `--member=serviceAccount:${sa(caller)}`,
          '--role=roles/run.invoker',
          '--condition=None',
        ]);
      if (service === 'gateway')
        mutate([
          'run',
          'services',
          'add-iam-policy-binding',
          serviceName(service),
          ...regionFlags,
          `--member=${operator}`,
          '--role=roles/run.invoker',
          '--condition=None',
        ]);
      const ready = runDescribe(service);
      urls[service] = ready.status.url;
      if (!urls[service]?.startsWith('https://'))
        throw new Error(`${service} has no ready Cloud Run URL`);
      verifyPolicy(
        json(['run', 'services', 'get-iam-policy', serviceName(service), ...regionFlags]),
        service,
      );
    }
    // Scheduled authenticated requests ensure outboxes drain even after scale-to-zero.
    for (const service of ['identity', 'documents', 'signing']) {
      const job = `${name}-${service}-outbox`;
      const existing = optional(['scheduler', 'jobs', 'describe', job, '--location', region]);
      if (existing && existing.description !== marker)
        throw new Error('Scheduler job belongs to another deployment');
      mutate([
        'scheduler',
        'jobs',
        existing ? 'update' : 'create',
        'http',
        job,
        '--location',
        region,
        `--description=${marker}`,
        '--schedule=* * * * *',
        '--time-zone=UTC',
        `--uri=${urls[service]}/internal/outbox/drain`,
        '--http-method=POST',
        `--oidc-service-account-email=${sa('scheduler')}`,
        `--oidc-token-audience=${urls[service]}`,
        '--attempt-deadline=180s',
      ]);
    }
    console.log('Checking gateway and service-to-service connections…');
    const idToken = gc(['auth', 'print-identity-token']);
    const headers = { authorization: `Bearer ${idToken}` };
    const sessionResponse = await fetch(`${urls.gateway}/api/session`, {
      headers,
      signal: AbortSignal.timeout(120000),
    });
    if (
      !sessionResponse.ok ||
      (await sessionResponse.json()).mode !== (production ? 'google' : 'demo')
    )
      throw new Error('Gateway session health check failed');
    if (production) {
      const readiness = await fetch(`${urls.gateway}/ready`, {
        headers,
        signal: AbortSignal.timeout(120000),
      });
      const ready = await readiness.json();
      if (!readiness.ok || ready.status !== 'ok' || ready.release !== release)
        throw new Error('Production backend/database readiness check failed');
      const disabledDemo = await fetch(`${urls.gateway}/api/auth/demo`, {
        method: 'POST',
        headers: { ...headers, origin },
        signal: AbortSignal.timeout(120000),
      });
      if (disabledDemo.status !== 404)
        throw new Error('Demo login must be disabled before public access');
      const protectedAPI = await fetch(`${urls.gateway}/api/documents`, {
        headers,
        signal: AbortSignal.timeout(120000),
      });
      if (protectedAPI.status !== 401)
        throw new Error('Unauthenticated document access must be rejected');
      const googleStart = await fetch(`${urls.gateway}/api/auth/google/start`, {
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(120000),
      });
      const loginURL = new URL(googleStart.headers.get('location') ?? 'https://invalid.test');
      const cookie = googleStart.headers.get('set-cookie') ?? '';
      if (
        googleStart.status !== 302 ||
        loginURL.origin !== 'https://accounts.google.com' ||
        loginURL.searchParams.get('client_id') !== config.google.clientId ||
        loginURL.searchParams.get('redirect_uri') !== `${origin}/api/auth/google/callback` ||
        !cookie.startsWith('__Host-pston_oauth=') ||
        !/; Secure/i.test(cookie) ||
        !/; HttpOnly/i.test(cookie)
      )
        throw new Error('Google redirect or secure browser cookie check failed');
      mutate([
        'run',
        'services',
        'add-iam-policy-binding',
        serviceName('gateway'),
        ...regionFlags,
        '--member=allUsers',
        '--role=roles/run.invoker',
        '--condition=None',
      ]);
      verifyPolicy(
        json(['run', 'services', 'get-iam-policy', serviceName('gateway'), ...regionFlags]),
        'gateway',
      );
      const browserReady = await fetch(`${origin}/ready`, {
        signal: AbortSignal.timeout(120000),
        redirect: 'error',
      });
      if (!browserReady.ok || (await browserReady.json()).release !== release)
        throw new Error(
          'HTTPS domain does not reach this release. Check DNS/load balancer routing to the gateway, then rerun.',
        );
      const browserDocuments = await fetch(`${origin}/api/documents`, {
        signal: AbortSignal.timeout(120000),
        redirect: 'error',
      });
      if (browserDocuments.status !== 401)
        throw new Error('Public origin must enforce application login');
    } else {
      const login = await fetch(`${urls.gateway}/api/auth/demo`, {
        method: 'POST',
        headers: { ...headers, origin },
        signal: AbortSignal.timeout(120000),
      });
      if (!login.ok) throw new Error('Gateway-to-identity check failed');
      const session = await login.json();
      const cookie = login.headers.get('set-cookie')?.split(';')[0];
      if (!cookie) throw new Error('Session cookie missing');
      try {
        const status = await fetch(`${urls.gateway}/api/system`, {
          headers: { ...headers, cookie },
          signal: AbortSignal.timeout(120000),
        });
        const system = await status.json();
        if (
          !status.ok ||
          system.services?.length !== 4 ||
          system.services.some((s) => s.status !== 'ok')
        )
          throw new Error('One or more internal services failed the smoke check');
      } finally {
        await fetch(`${urls.gateway}/api/auth/logout`, {
          method: 'POST',
          headers: {
            ...headers,
            cookie,
            origin,
            'x-csrf-token': session.csrf,
            'content-type': 'application/json',
          },
          body: '{}',
          signal: AbortSignal.timeout(120000),
        });
      }
    }
    const stateDir = join(root, '.local', 'gcp-deploy', project, region, name);
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(stateDir, 'last-deployment.json'),
      JSON.stringify(
        {
          project,
          region,
          name,
          environment: config.environment,
          origin,
          port,
          image,
          urls,
          completedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    if (production)
      console.log(
        `\nProduction deployment checks passed. Browser: ${origin}\nGoogle login must still be accepted with your real account. TDID signing is disabled pending HSM integration and trust validation.\nCloud SQL HA continues to incur charges when idle.`,
      );
    else
      console.log(
        `\nDeployment checks passed. Cloud Run gateway (IAM protected): ${urls.gateway}\nBrowser: ${origin}\nReconnect: npm run deploy:gcp -- --project ${project} --region ${region} --name ${name} --port ${port} --connect\nCloud SQL continues to incur charges when this terminal is closed.`,
      );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  if (config.proxy) await proxy();

  async function proxy() {
    console.log(
      `Opening the authenticated Cloud Run proxy at ${origin}. Keep this terminal open; Ctrl+C closes only the proxy.`,
    );
    const child = spawn(
      'gcloud',
      [
        'run',
        'services',
        'proxy',
        serviceName('gateway'),
        ...regionFlags,
        '--project',
        project,
        `--port=${port}`,
        '--quiet',
      ],
      { stdio: 'inherit' },
    );
    let ended = false,
      spawnError;
    const done = new Promise((resolve) => {
      child.once('error', (error) => {
        spawnError = error;
        ended = true;
        resolve(1);
      });
      child.once('exit', (code) => {
        ended = true;
        resolve(code ?? 0);
      });
    });
    const stop = () => child.kill('SIGTERM');
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      let ready = false;
      for (let attempt = 0; attempt < 60 && !ended; attempt++) {
        try {
          const response = await fetch(`${origin}/api/session`, {
            signal: AbortSignal.timeout(2000),
          });
          if (response.ok) {
            ready = true;
            break;
          }
        } catch {
          /* Proxy still starting. */
        }
        await sleep(1000);
      }
      if (!ready) {
        stop();
        throw new Error(
          spawnError?.message ??
            'Proxy did not become ready; use the reconnect command after checking gcloud components and port availability.',
        );
      }
      const browser = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [origin], {
        stdio: 'ignore',
      });
      browser.on('error', () => console.log(`Open ${origin} in your browser.`));
      browser.unref();
      const code = await done;
      if (code) throw new Error(`Cloud Run proxy exited with code ${code}`);
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(`\nDeployment stopped: ${error.message}`);
    if (error.detail) console.error(error.detail);
    console.error(
      'Existing cloud resources and data have been retained. Fix the reported step and rerun the same command; do not delete the database/buckets to retry.',
    );
    process.exitCode = 1;
  });
