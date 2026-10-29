import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import staticPlugin from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { createApp, rpc, rpcResponse, listen } from '../../../packages/core/src/http.js';
import {
  webOrigin,
  secureCookie,
  mode,
  maxPdfBytes,
  production,
} from '../../../packages/core/src/config.js';
import { equalSecret } from '../../../packages/core/src/security.js';
import { ensure } from '../../../packages/core/src/errors.js';
import type { Session, ServiceName } from '../../../packages/core/src/types.js';

const app = await createApp('gateway');
const sessionCookie = production ? '__Host-pston_session' : 'pston_session';
const oauthCookie = production ? '__Host-pston_oauth' : 'pston_oauth';
await app.register(cookie);
await app.register(helmet, {
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      fontSrc: ["'self'"],
      connectSrc: ["'self'"],
      workerSrc: ["'self'", 'blob:'],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
      upgradeInsecureRequests: secureCookie ? [] : null,
    },
  },
});
app.addContentTypeParser(/^multipart\/form-data/, { parseAs: 'buffer' }, (_req, body, done) =>
  done(null, body),
);
const cookieOptions = {
  path: '/',
  httpOnly: true,
  secure: secureCookie,
  sameSite: 'lax' as const,
  maxAge: 12 * 60 * 60,
};
type SessionResponse = Partial<Session> & { user: Session['user'] | null; mode: string };
async function getSession(token?: string) {
  const session = await rpc<SessionResponse>('gateway', 'identity', '/session', {
    method: 'POST',
    body: { token },
  });
  return { ...session, maxPdfBytes };
}
app.addHook('onRequest', async (req, reply) => {
  reply.header('cache-control', 'no-store');
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method))
    ensure(
      req.headers.origin === webOrigin,
      403,
      'ORIGIN_REJECTED',
      'Request origin is not allowed',
    );
});
app.get(
  '/ready',
  { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
  async (_req, reply) => {
    const statuses = await Promise.allSettled(
      (['identity', 'documents', 'signing', 'audit'] as const).map((service) =>
        rpc('gateway', service, '/ready', { timeoutMs: 10000 }),
      ),
    );
    const healthy = statuses.every((s) => s.status === 'fulfilled');
    return reply
      .code(healthy ? 200 : 503)
      .send({ status: healthy ? 'ok' : 'unavailable', release: process.env.PSTON_RELEASE });
  },
);
app.get('/api/session', async (req) => getSession(req.cookies[sessionCookie]));
app.post('/api/auth/demo', async (_req, reply) => {
  ensure(mode === 'demo', 404, 'NOT_FOUND', 'Not found');
  const session = await rpc<Session & { token: string }>('gateway', 'identity', '/auth/demo', {
    method: 'POST',
  });
  reply.setCookie(sessionCookie, session.token, cookieOptions);
  return getSession(session.token);
});
app.get(
  '/api/auth/google/start',
  { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
  async (_req, reply) => {
    ensure(mode === 'google', 404, 'NOT_FOUND', 'Not found');
    const result = await rpc<{ url: string; browserToken: string }>(
      'gateway',
      'identity',
      '/auth/google/start',
    );
    reply.setCookie(oauthCookie, result.browserToken, { ...cookieOptions, maxAge: 300 });
    return reply.redirect(result.url);
  },
);
app.get(
  '/api/auth/google/callback',
  { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
  async (req, reply) => {
    ensure(mode === 'google', 404, 'NOT_FOUND', 'Not found');
    const { code, state } = z.object({ code: z.string(), state: z.string() }).parse(req.query);
    const session = await rpc<Session & { token: string }>(
      'gateway',
      'identity',
      '/auth/google/callback',
      { method: 'POST', body: { code, state, browserToken: req.cookies[oauthCookie] ?? '' } },
    );
    reply.clearCookie(oauthCookie, cookieOptions);
    reply.setCookie(sessionCookie, session.token, cookieOptions);
    return reply.redirect(webOrigin);
  },
);
app.get<{ Params: { id: string } }>('/api/verify/:id', async (req) =>
  rpc('gateway', 'documents', `/verification/${encodeURIComponent(req.params.id)}`),
);
app.post<{ Params: { id: string } }>('/api/verify/:id/check', async (req) => {
  const { sha256 } = z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }).parse(req.body);
  const record = await rpc<{ sha256: string }>(
    'gateway',
    'documents',
    `/verification/${encodeURIComponent(req.params.id)}`,
  );
  return { matches: equalSecret(sha256, record.sha256), scope: 'exact_file_only' };
});
app.register(async (api) => {
  api.addHook('preHandler', async (req) => {
    const session = await getSession(req.cookies[sessionCookie]);
    ensure(session.user, 401, 'LOGIN_REQUIRED', 'กรุณาเข้าสู่ระบบ');
    req.actor = session.user.id;
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method))
      ensure(
        session.csrf &&
          typeof req.headers['x-csrf-token'] === 'string' &&
          equalSecret(session.csrf, req.headers['x-csrf-token']),
        403,
        'CSRF_REJECTED',
        'CSRF token is missing or invalid',
      );
  });
  api.post('/api/auth/logout', async (req, reply) => {
    const all = z.object({ all: z.boolean().default(false) }).parse(req.body ?? {}).all;
    await rpc('gateway', 'identity', '/auth/logout', {
      method: 'POST',
      actor: req.actor,
      body: { token: req.cookies[sessionCookie], all },
    });
    reply.clearCookie(sessionCookie, cookieOptions);
    return { ok: true };
  });
  api.get('/api/system', async () => {
    const names: ServiceName[] = ['identity', 'documents', 'signing', 'audit'];
    const services = await Promise.all(
      names.map(async (name) => {
        try {
          await rpc('gateway', name, '/health');
          return { name, status: 'ok' };
        } catch {
          return { name, status: 'unavailable' };
        }
      }),
    );
    return { services, mode, productionReady: false };
  });
  const routes: Array<{
    method: 'GET' | 'POST' | 'DELETE';
    path: string;
    service: ServiceName;
    target?: string;
  }> = [
    { method: 'GET', path: '/certificates/imports', service: 'signing' },
    { method: 'POST', path: '/certificates/imports', service: 'signing' },
    { method: 'GET', path: '/certificates/imports/:id', service: 'signing' },
    { method: 'POST', path: '/certificates/imports/:id', service: 'signing' },
    { method: 'GET', path: '/credentials', service: 'identity' },
    { method: 'POST', path: '/webauthn/register/options', service: 'identity' },
    { method: 'POST', path: '/webauthn/register/verify', service: 'identity' },
    { method: 'POST', path: '/approval/options', service: 'identity' },
    { method: 'POST', path: '/approval/verify', service: 'identity' },
    { method: 'POST', path: '/approval/demo', service: 'identity' },
    { method: 'GET', path: '/documents', service: 'documents' },
    { method: 'POST', path: '/documents', service: 'documents' },
    { method: 'POST', path: '/documents/sample', service: 'documents' },
    { method: 'GET', path: '/documents/:id', service: 'documents' },
    { method: 'POST', path: '/documents/:id/draft', service: 'documents' },
    { method: 'POST', path: '/documents/:id/preview', service: 'documents' },
    { method: 'POST', path: '/documents/:id/duplicate', service: 'documents' },
    { method: 'POST', path: '/documents/:id/restore', service: 'documents' },
    { method: 'POST', path: '/documents/:id/verify', service: 'documents' },
    { method: 'DELETE', path: '/documents/:id', service: 'documents' },
    { method: 'GET', path: '/documents/:id/revisions/:revisionId/file', service: 'documents' },
    { method: 'GET', path: '/previews/:id/file', service: 'documents' },
    { method: 'GET', path: '/certificates', service: 'signing' },
    { method: 'POST', path: '/certificates', service: 'signing' },
    { method: 'GET', path: '/security', service: 'signing' },
    { method: 'POST', path: '/security/lock', service: 'signing' },
    { method: 'POST', path: '/signing/prepare', service: 'signing' },
    { method: 'GET', path: '/signing/:id', service: 'signing' },
    { method: 'POST', path: '/signing/:id/execute', service: 'signing' },
    { method: 'POST', path: '/signing/:id/reconcile', service: 'signing' },
    { method: 'GET', path: '/audit/events', service: 'audit', target: '/events' },
    { method: 'GET', path: '/audit/integrity', service: 'audit', target: '/integrity' },
  ];
  for (const route of routes)
    api.route({
      method: route.method,
      url: '/api' + route.path,
      handler: async (req, reply) => {
        let target = route.target ?? route.path;
        for (const [key, value] of Object.entries(req.params as Record<string, string>))
          target = target.replace(':' + key, encodeURIComponent(value));
        const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
        const raw = Buffer.isBuffer(req.body) ? req.body : undefined;
        const response = await rpcResponse('gateway', route.service, target + query, {
          method: req.method,
          actor: req.actor,
          body: raw ? undefined : req.body,
          raw,
          headers: raw ? { 'content-type': req.headers['content-type']! } : undefined,
        });
        reply.code(response.status);
        for (const key of ['content-type', 'content-disposition']) {
          const value = response.headers.get(key);
          if (value) reply.header(key, value);
        }
        return reply.send(Buffer.from(await response.arrayBuffer()));
      },
    });
});
if (existsSync(resolve('dist/web/index.html'))) {
  await app.register(staticPlugin, { root: resolve('dist/web'), prefix: '/' });
  app.setNotFoundHandler((req, reply) =>
    req.url.startsWith('/api/')
      ? reply.code(404).send({ error: 'NOT_FOUND' })
      : reply.sendFile('index.html'),
  );
}
await listen(app, 'gateway', Number(process.env.GATEWAY_PORT ?? 3000));
