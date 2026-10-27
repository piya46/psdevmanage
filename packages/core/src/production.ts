import type { ServiceName } from './types.js';
import { readGoogleAllowlist } from './google-allowlist.mjs';

/** Validate before opening sockets, databases or accepting requests. */
export function validateProduction(env: NodeJS.ProcessEnv, service?: ServiceName) {
  if (env.NODE_ENV !== 'production') return;
  const required = (name: string) => {
    if (!env[name]?.trim()) throw new Error(`Production requires ${name}`);
  };
  for (const key of ['WEB_ORIGIN', 'PSTON_SERVICE_KEY_FILE', 'PSTON_PUBLIC_KEYS_FILE'])
    required(key);
  const origin = new URL(env.WEB_ORIGIN!);
  if (
    origin.protocol !== 'https:' ||
    origin.origin !== env.WEB_ORIGIN ||
    origin.hostname === 'localhost' ||
    origin.username ||
    origin.password
  )
    throw new Error('Production WEB_ORIGIN must be an HTTPS origin without a path');
  if (
    env.PSTON_MODE !== 'google' ||
    env.PSTON_STORE !== 'postgres' ||
    env.PSTON_CLOUD_RUN !== 'true'
  )
    throw new Error('Production requires Google login, PostgreSQL and Cloud Run IAM');
  if (
    env.PSTON_SIGNING_PROVIDER !== 'disabled' ||
    env.PSTON_DEMO_CERT_FILE ||
    env.PSTON_DEMO_KEY_FILE
  )
    throw new Error(
      'Production signing must remain disabled until the TDID HSM adapter is accepted',
    );
  if (service === 'identity') {
    for (const key of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']) required(key);
    if (!env.GOOGLE_CLIENT_ID!.endsWith('.apps.googleusercontent.com'))
      throw new Error('Invalid Google OAuth Web Client ID');
    const allowlist = readGoogleAllowlist(env);
    if (!allowlist.emails.length && !allowlist.subjects.length)
      throw new Error('Production requires GOOGLE_ALLOWED_EMAILS (or legacy GOOGLE_ALLOWED_SUBS)');
    if (env.GOOGLE_REDIRECT_URI !== `${env.WEB_ORIGIN}/api/auth/google/callback`)
      throw new Error('Google redirect URI must match WEB_ORIGIN');
  }
  if (service && service !== 'gateway') {
    for (const key of ['PGHOST', 'PGDATABASE', 'PGUSER', 'PGPASSWORD']) required(key);
    if (!env.PGHOST!.startsWith('/cloudsql/'))
      throw new Error('Production requires a Cloud SQL socket');
  }
  if (service === 'documents' || service === 'signing') required('PSTON_BLOB_BUCKET');
  const destinations: Partial<Record<ServiceName, string[]>> = {
    gateway: ['IDENTITY_URL', 'DOCUMENTS_URL', 'SIGNING_URL', 'AUDIT_URL'],
    identity: ['AUDIT_URL'],
    documents: ['AUDIT_URL'],
    signing: ['DOCUMENTS_URL', 'AUDIT_URL'],
  };
  for (const key of service ? (destinations[service] ?? []) : []) {
    required(key);
    if (new URL(env[key]!).protocol !== 'https:') throw new Error(`${key} must use HTTPS`);
  }
}
