import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { serviceURLs } from './config.js';
import { issueToken, verifyToken, bearer } from './security.js';
import { AppError } from './errors.js';
import type { ServiceName } from './types.js';
import type { Store } from './store.js';
import { GoogleAuth } from 'google-auth-library';
import { validateProduction } from './production.js';

const googleAuth = new GoogleAuth();
const idClients = new Map<string, ReturnType<GoogleAuth['getIdTokenClient']>>();

declare module 'fastify' {
  interface FastifyRequest {
    actor?: string;
    caller?: ServiceName;
  }
}
export async function createApp(service: ServiceName) {
  validateProduction(process.env, service);
  const app = Fastify({
    bodyLimit: (process.env.K_SERVICE ? 30 : 80) * 1024 * 1024,
    requestTimeout: 120000,
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
      serializers: {
        req: (req: { method: string; url: string }) => ({
          method: req.method,
          path: req.url.split('?')[0],
        }),
      },
    },
  });
  // Install the onRoute hook before any routes are declared.
  // This is a per-instance limit, not a distributed edge rate limit.
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  app.setErrorHandler((err, req, reply) => {
    const e = err as Error & { statusCode?: number; code?: string };
    if (e instanceof ZodError)
      return reply.code(400).send({
        error: 'VALIDATION_ERROR',
        message: e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
    if ((e.statusCode ?? 500) >= 500)
      req.log.error({ code: e.code ?? 'INTERNAL', message: e.message }, 'Request failed');
    return reply.code(e.statusCode ?? 500).send({
      error: e instanceof AppError ? e.code : 'REQUEST_FAILED',
      message: (e.statusCode ?? 500) < 500 ? e.message : 'ไม่สามารถดำเนินการได้ กรุณาลองใหม่',
    });
  });
  app.get('/health', { config: { rateLimit: false } }, async () => ({
    service: `pston-${service}`,
    status: 'ok',
  }));
  return app;
}
export async function internalAuth(
  app: FastifyInstance,
  service: ServiceName,
  allowed: ServiceName[],
) {
  app.addHook('preHandler', async (req) => {
    if (req.url.split('?')[0] === '/health') return;
    // This endpoint is exposed only on IAM-protected Cloud Run services. Cloud
    // Scheduler supplies its Google ID token; it cannot read or modify records.
    if (process.env.K_SERVICE && req.url.split('?')[0] === '/internal/outbox/drain') return;
    const token = await verifyToken(bearer(req.headers.authorization), `pston:${service}`, allowed);
    if (token.purpose !== 'service')
      throw new AppError(401, 'INVALID_PURPOSE', 'Invalid service token purpose');
    req.actor = typeof token.sub === 'string' ? token.sub : undefined;
    req.caller = token.iss!.slice(6) as ServiceName;
  });
}
export function actor(req: FastifyRequest) {
  if (!req.actor) throw new AppError(401, 'LOGIN_REQUIRED', 'กรุณาเข้าสู่ระบบ');
  return req.actor;
}
export function caller(req: FastifyRequest, allowed: ServiceName[]) {
  if (!req.caller || !allowed.includes(req.caller))
    throw new AppError(403, 'SERVICE_FORBIDDEN', 'Service is not authorized for this operation');
}
export function databaseReadiness(app: FastifyInstance, store: Store) {
  app.get('/ready', { config: { rateLimit: false } }, async () => {
    await store.get('runtime_health', 'probe');
    return { status: 'ok' };
  });
}
export async function rpcResponse(
  from: ServiceName,
  to: ServiceName,
  path: string,
  options: {
    method?: string;
    body?: unknown;
    actor?: string;
    headers?: Record<string, string>;
    raw?: Buffer;
    timeoutMs?: number;
  } = {},
) {
  const headers: Record<string, string> = {
    authorization: `Bearer ${await issueToken(from, `pston:${to}`, { purpose: 'service', sub: options.actor })}`,
    ...options.headers,
  };
  let body: BodyInit | undefined;
  if (process.env.PSTON_CLOUD_RUN === 'true') {
    if (!serviceURLs[to].startsWith('https://'))
      throw new Error('Cloud Run destination must use HTTPS');
    if (!idClients.has(serviceURLs[to]))
      idClients.set(serviceURLs[to], googleAuth.getIdTokenClient(serviceURLs[to]));
    const client = await idClients.get(serviceURLs[to])!;
    const tokenHeaders = await client.getRequestHeaders();
    headers['X-Serverless-Authorization'] = tokenHeaders.get('authorization')!;
  }
  if (options.raw) body = new Uint8Array(options.raw);
  else if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  return fetch(serviceURLs[to] + path, {
    method: options.method ?? 'GET',
    headers,
    body,
    signal: AbortSignal.timeout(options.timeoutMs ?? 90000),
  });
}
export async function rpc<T>(
  from: ServiceName,
  to: ServiceName,
  path: string,
  options: Parameters<typeof rpcResponse>[3] = {},
): Promise<T> {
  const res = await rpcResponse(from, to, path, options);
  const data = (await res.json()) as T & { error?: string; message?: string };
  if (!res.ok)
    throw new AppError(
      res.status,
      data.error ?? 'UPSTREAM_FAILURE',
      data.message ?? 'Service request failed',
    );
  return data;
}
export function startOutbox(store: Store, app: FastifyInstance) {
  let busy = false;
  const deliver = async () => {
    if (busy) return;
    busy = true;
    try {
      const deadline = Date.now() + 5000;
      for (const event of await store.pendingEvents()) {
        await rpc(store.service, 'audit', '/events', {
          method: 'POST',
          actor: event.owner,
          body: event,
          timeoutMs: 5000,
        });
        await store.acknowledge(event.id);
        if (Date.now() >= deadline) break;
      }
    } catch {
      app.log.warn('Audit delivery deferred; durable outbox retained');
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(deliver, 1500);
  if (process.env.K_SERVICE)
    app.post('/internal/outbox/drain', async () => {
      await deliver();
      return { pending: (await store.pendingEvents()).length };
    });
  // Request-based Cloud Run CPU can pause between requests. Flush before sending
  // a response as well; failed deliveries remain durable and retry next request.
  app.addHook('onSend', async (_req, _reply, payload) => {
    await deliver();
    return payload;
  });
  timer.unref();
  app.addHook('onClose', async () => {
    clearInterval(timer);
    await store.close();
  });
}
export async function listen(app: FastifyInstance, service: ServiceName, port: number) {
  const configuredPort = process.env.PORT ?? process.env[`${service.toUpperCase()}_PORT`];
  await app.listen({
    port: configuredPort ? Number(configuredPort) : port,
    host: process.env.HOST ?? '127.0.0.1',
  });
  for (const sig of ['SIGINT', 'SIGTERM'] as const)
    process.once(sig, () => {
      void app.close().then(() => process.exit(0));
    });
  app.log.info({ service }, 'PSTON service ready');
}
