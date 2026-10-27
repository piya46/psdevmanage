import { databaseReadiness } from '../../../packages/core/src/http.js';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
} from '@simplewebauthn/server';
import {
  createApp,
  internalAuth,
  actor,
  listen,
  startOutbox,
} from '../../../packages/core/src/http.js';
import { Store } from '../../../packages/core/src/store.js';
import { mode, webOrigin, rpID } from '../../../packages/core/src/config.js';
import {
  sha256,
  now,
  equalSecret,
  issueToken,
  verifyToken,
} from '../../../packages/core/src/security.js';
import { ensure } from '../../../packages/core/src/errors.js';
import type { User } from '../../../packages/core/src/types.js';
import { acceptGoogleClaims, sessionUserAllowed } from './google-policy.js';
import { readGoogleAllowlist } from '../../../packages/core/src/google-allowlist.mjs';
interface SessionData {
  id: string;
  user: User;
  csrf: string;
  created: number;
  lastSeen: number;
  revoked: boolean;
  emailAuthorized?: boolean;
}
interface Credential {
  id: string;
  owner: string;
  publicKey: string;
  counter: number;
  transports?: AuthenticatorTransport[];
  createdAt: string;
}
interface Challenge {
  challenge: string;
  expires: number;
  manifest?: string;
  used: boolean;
}
const app = await createApp('identity');
const store = await Store.open('identity');
databaseReadiness(app, store);
await internalAuth(app, 'identity', ['gateway']);
startOutbox(store, app);
const jwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const googleAllowlist = () => readGoogleAllowlist(mode === 'google' ? process.env : {});
async function newSession(user: User, emailAuthorized = false) {
  const raw = randomBytes(32).toString('base64url');
  const id = sha256(raw);
  const session: SessionData = {
    id,
    user,
    csrf: randomBytes(32).toString('base64url'),
    created: Date.now(),
    lastSeen: Date.now(),
    revoked: false,
    emailAuthorized,
  };
  await store.transaction(async () => {
    await store.insert('sessions', id, user.id, session);
    await store.event(user.id, 'auth.login', id, { mode: user.mode });
  });
  return { token: raw, user, csrf: session.csrf };
}
app.post('/auth/demo', async () => {
  ensure(mode === 'demo', 404, 'NOT_FOUND', 'Not found');
  return await newSession({
    id: 'demo-owner',
    name: 'เจ้าของพื้นที่ทดลอง',
    email: 'owner@pston.test',
    mode: 'demo',
  });
});
app.post('/session', async (req) => {
  const { token } = z.object({ token: z.string().max(200).optional() }).parse(req.body);
  if (!token) return { user: null, mode, googleConfigured: !!process.env.GOOGLE_CLIENT_ID };
  return store.transaction(async () => {
    const session = await store.get<SessionData>('sessions', sha256(token));
    if (
      !session ||
      session.revoked ||
      !sessionUserAllowed(session.user, mode, googleAllowlist(), session.emailAuthorized) ||
      Date.now() - session.created > 12 * 60 * 60 * 1000 ||
      Date.now() - session.lastSeen > 30 * 60 * 1000
    )
      return { user: null, mode };
    session.lastSeen = Date.now();
    await store.put('sessions', session.id, session.user.id, session);
    return {
      user: session.user,
      csrf: session.csrf,
      mode,
      passkeys: (await store.list<Credential>('credentials', session.user.id)).length,
    };
  });
});
app.post('/auth/logout', async (req) => {
  const owner = actor(req);
  const { token, all } = z
    .object({ token: z.string(), all: z.boolean().default(false) })
    .parse(req.body);
  await store.transaction(async () => {
    for (const session of await store.list<SessionData>('sessions', owner))
      if (all || session.id === sha256(token)) {
        session.revoked = true;
        await store.put('sessions', session.id, owner, session);
      }
    await store.event(owner, 'auth.logout', owner, { all });
  });
  return { ok: true };
});
app.get('/auth/google/start', async () => {
  ensure(mode === 'google', 404, 'NOT_FOUND', 'Not found');
  const allowlist = googleAllowlist();
  ensure(
    process.env.GOOGLE_CLIENT_ID &&
      process.env.GOOGLE_CLIENT_SECRET &&
      (allowlist.emails.length || allowlist.subjects.length),
    503,
    'GOOGLE_NOT_CONFIGURED',
    'ยังไม่ได้ตั้งค่า Google Login และ Allowlist',
  );
  const state = randomBytes(32).toString('base64url'),
    nonce = randomBytes(32).toString('base64url'),
    verifier = randomBytes(48).toString('base64url');
  const browserToken = randomBytes(32).toString('base64url');
  await store.insert('oauth', sha256(state), 'system', {
    nonce,
    verifier,
    browserHash: sha256(browserToken),
    expires: Date.now() + 300000,
  });
  const redirect = process.env.GOOGLE_REDIRECT_URI ?? `${webOrigin}/api/auth/google/callback`;
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirect,
    scope: 'openid email profile',
    state,
    nonce,
    code_challenge: Buffer.from(sha256(verifier), 'hex').toString('base64url'),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  return { url: url.toString(), browserToken };
});
app.post('/auth/google/callback', async (req) => {
  ensure(mode === 'google', 404, 'NOT_FOUND', 'Not found');
  const body = z
    .object({
      code: z.string().max(4096),
      state: z.string().max(256),
      browserToken: z.string().max(256),
    })
    .parse(req.body);
  const state = await store.transaction(async () => {
    const state = await store.get<{
      nonce: string;
      verifier: string;
      browserHash: string;
      expires: number;
    }>('oauth', sha256(body.state));
    ensure(
      state &&
        state.expires > Date.now() &&
        equalSecret(state.browserHash, sha256(body.browserToken)),
      401,
      'INVALID_OAUTH_STATE',
      'Google login state expired or invalid',
    );
    await store.remove('oauth', sha256(body.state));
    return state;
  });
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: body.code,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: process.env.GOOGLE_REDIRECT_URI ?? `${webOrigin}/api/auth/google/callback`,
      grant_type: 'authorization_code',
      code_verifier: state.verifier,
    }),
    signal: AbortSignal.timeout(15000),
  });
  ensure(response.ok, 401, 'GOOGLE_TOKEN_REJECTED', 'Google rejected the authorization code');
  const tokens = (await response.json()) as {
    id_token: string;
  };
  const { payload } = await jwtVerify(tokens.id_token, jwks, {
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
    audience: process.env.GOOGLE_CLIENT_ID,
    algorithms: ['RS256'],
    requiredClaims: ['sub', 'exp', 'iat', 'nonce', 'email', 'email_verified'],
  });
  const allowlist = googleAllowlist();
  const subject = acceptGoogleClaims(payload, {
    nonce: state.nonce,
    clientId: process.env.GOOGLE_CLIENT_ID!,
    allowlist,
  });
  return await newSession(
    {
      id: subject,
      name: typeof payload.name === 'string' ? payload.name : 'PSTON Owner',
      email: typeof payload.email === 'string' ? payload.email : '',
      mode: 'google',
    },
    allowlist.emails.length > 0,
  );
});
app.get('/credentials', async (req) => ({
  credentials: (await store.list<Credential>('credentials', actor(req))).map((c) => ({
    id: c.id,
    createdAt: c.createdAt,
  })),
}));
app.post('/webauthn/register/options', async (req) => {
  const owner = actor(req);
  ensure(
    (await store.list('credentials', owner)).length === 0,
    409,
    'REAUTH_REQUIRED',
    'มี Passkey แล้ว การเพิ่มหรือกู้คืนต้องใช้ขั้นตอนยืนยันเพิ่มเติม',
  );
  const options = await generateRegistrationOptions({
    rpName: 'PSTON',
    rpID,
    userName: owner,
    userID: new TextEncoder().encode(owner),
    attestationType: 'none',
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    timeout: 120000,
  });
  await store.put('challenges', `register:${owner}`, owner, {
    challenge: options.challenge,
    expires: Date.now() + 120000,
    used: false,
  } satisfies Challenge);
  return options;
});
app.post('/webauthn/register/verify', async (req) => {
  const owner = actor(req);
  const challenge = await store.get<Challenge>('challenges', `register:${owner}`);
  ensure(
    challenge && !challenge.used && challenge.expires > Date.now(),
    401,
    'CHALLENGE_EXPIRED',
    'Passkey challenge expired',
  );
  const result = await verifyRegistrationResponse({
    response: req.body as RegistrationResponseJSON,
    expectedChallenge: challenge.challenge,
    expectedOrigin: webOrigin,
    expectedRPID: rpID,
    requireUserVerification: true,
  });
  ensure(
    result.verified && result.registrationInfo,
    401,
    'PASSKEY_REJECTED',
    'Passkey registration failed',
  );
  const credential = result.registrationInfo.credential;
  await store.transaction(async () => {
    const current = await store.get<Challenge>('challenges', `register:${owner}`);
    ensure(
      current &&
        !current.used &&
        current.challenge === challenge.challenge &&
        (await store.list('credentials', owner)).length === 0,
      409,
      'CHALLENGE_USED',
      'Registration already consumed',
    );
    current.used = true;
    await store.put('challenges', `register:${owner}`, owner, current);
    await store.insert('credentials', credential.id, owner, {
      id: credential.id,
      owner,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter,
      transports: credential.transports?.filter((t): t is AuthenticatorTransport =>
        ['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb'].includes(t),
      ),
      createdAt: now(),
    } satisfies Credential);
    await store.event(owner, 'auth.passkey_registered', credential.id);
  });
  return { verified: true };
});
async function validateManifest(token: string, owner: string) {
  const manifest = await verifyToken(token, 'pston:approval-manifest', ['signing']);
  ensure(
    manifest.sub === owner &&
      manifest.purpose === 'sign' &&
      typeof manifest.requestId === 'string' &&
      typeof manifest.preparedHash === 'string',
    403,
    'MANIFEST_MISMATCH',
    'Signing manifest does not match account',
  );
  return manifest;
}
app.post('/approval/options', async (req) => {
  const owner = actor(req);
  const { manifestToken } = z.object({ manifestToken: z.string().max(12000) }).parse(req.body);
  const manifest = await validateManifest(manifestToken, owner);
  const creds = await store.list<Credential>('credentials', owner);
  ensure(creds.length, 409, 'PASSKEY_REQUIRED', 'กรุณาลงทะเบียน Passkey ก่อนลงนาม');
  const challenge = Buffer.from(
    sha256(manifestToken + randomBytes(32).toString('hex')),
    'hex',
  ).toString('base64url');
  const options = await generateAuthenticationOptions({
    rpID,
    challenge,
    userVerification: 'required',
    allowCredentials: creds.map((c) => ({ id: c.id, transports: c.transports })),
    timeout: 120000,
  });
  await store.put('challenges', `sign:${manifest.requestId}`, owner, {
    challenge: options.challenge,
    manifest: manifestToken,
    expires: Date.now() + 120000,
    used: false,
  } satisfies Challenge);
  return options;
});
app.post('/approval/verify', async (req) => {
  const owner = actor(req);
  const body = z.object({ manifestToken: z.string(), response: z.unknown() }).parse(req.body);
  const manifest = await validateManifest(body.manifestToken, owner);
  const challenge = await store.get<Challenge>('challenges', `sign:${manifest.requestId}`);
  ensure(
    challenge &&
      !challenge.used &&
      challenge.expires > Date.now() &&
      challenge.manifest === body.manifestToken,
    401,
    'APPROVAL_EXPIRED',
    'Approval expired or does not match the document',
  );
  const response = body.response as AuthenticationResponseJSON;
  const credential = await store.get<Credential>('credentials', response.id);
  ensure(
    credential && credential.owner === owner,
    403,
    'CREDENTIAL_NOT_OWNED',
    'Passkey does not belong to this account',
  );
  const result = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challenge.challenge,
    expectedOrigin: webOrigin,
    expectedRPID: rpID,
    credential: {
      id: credential.id,
      publicKey: new Uint8Array(Buffer.from(credential.publicKey, 'base64url')),
      counter: credential.counter,
      transports: credential.transports,
    },
    requireUserVerification: true,
  });
  ensure(result.verified, 401, 'APPROVAL_REJECTED', 'Passkey verification failed');
  await store.transaction(async () => {
    const storedCredential = await store.get<Credential>('credentials', credential.id);
    ensure(
      storedCredential?.owner === owner && storedCredential.counter === credential.counter,
      409,
      'CREDENTIAL_CHANGED',
      'Passkey was used concurrently; request a new approval',
    );
    const current = await store.get<Challenge>('challenges', `sign:${manifest.requestId}`);
    ensure(
      current && !current.used && current.challenge === challenge.challenge,
      409,
      'APPROVAL_USED',
      'Approval already consumed',
    );
    current.used = true;
    await store.put('challenges', `sign:${manifest.requestId}`, owner, current);
    credential.counter = result.authenticationInfo.newCounter;
    await store.put('credentials', credential.id, owner, credential);
    await store.event(owner, 'signing.approved', String(manifest.requestId), {
      preparedHash: String(manifest.preparedHash),
      method: 'webauthn',
    });
  });
  return {
    approvalToken: await issueToken(
      'identity',
      'pston:signing-approval',
      {
        ...approvalClaims(manifest),
        method: 'webauthn',
        evidenceHash: sha256(JSON.stringify(response)),
      },
      120,
    ),
  };
});
function approvalClaims(manifest: Record<string, unknown>) {
  return {
    sub: manifest.sub as string,
    purpose: 'sign-approval',
    requestId: manifest.requestId,
    preparedHash: manifest.preparedHash,
    documentDigest: manifest.documentDigest,
    certificateId: manifest.certificateId,
    nonce: manifest.nonce,
  };
}
app.post('/approval/demo', async (req) => {
  ensure(mode === 'demo', 404, 'NOT_FOUND', 'Not found');
  const owner = actor(req);
  const { manifestToken } = z.object({ manifestToken: z.string() }).parse(req.body);
  const manifest = await validateManifest(manifestToken, owner);
  ensure(
    manifest.testOnly === true,
    403,
    'DEMO_ONLY',
    'Demo approval cannot authorize a production certificate',
  );
  await store.event(owner, 'signing.approved', String(manifest.requestId), {
    preparedHash: String(manifest.preparedHash),
    method: 'demo-explicit-confirmation',
  });
  return {
    approvalToken: await issueToken(
      'identity',
      'pston:signing-approval',
      { ...approvalClaims(manifest), method: 'demo', evidenceHash: sha256(manifestToken) },
      120,
    ),
  };
});
// No password login, email-only recovery, or account self-enrollment endpoints.
await listen(app, 'identity', 3001);
