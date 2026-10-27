import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { SignJWT, importPKCS8, importSPKI, jwtVerify, decodeJwt, type JWTPayload } from 'jose';
import { dataRoot } from './config.js';
import type { ServiceName } from './types.js';
import { AppError } from './errors.js';

export const sha256 = (data: string | Uint8Array) =>
  createHash('sha256').update(data).digest('hex');
export const now = () => new Date().toISOString();
export function equalSecret(a: string, b: string) {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
const privateKeys = new Map<string, Promise<CryptoKey>>();
const publicKeys = new Map<string, Promise<CryptoKey>>();
function privateKey(service: ServiceName) {
  if (!privateKeys.has(service))
    privateKeys.set(
      service,
      importPKCS8(
        readFileSync(
          process.env.PSTON_SERVICE_KEY_FILE ?? join(dataRoot, 'keys', service, 'private.pem'),
          'utf8',
        ),
        'EdDSA',
      ),
    );
  return privateKeys.get(service)!;
}
function publicKey(service: string) {
  if (!publicKeys.has(service)) {
    const keys = JSON.parse(
      readFileSync(
        process.env.PSTON_PUBLIC_KEYS_FILE ?? join(dataRoot, 'keys', 'public-keys.json'),
        'utf8',
      ),
    ) as Record<string, string>;
    if (!keys[service]) throw new AppError(401, 'INVALID_SERVICE', 'Unknown service identity');
    publicKeys.set(service, importSPKI(keys[service], 'EdDSA'));
  }
  return publicKeys.get(service)!;
}
export async function issueToken(
  issuer: ServiceName,
  audience: string,
  claims: JWTPayload,
  ttl = 60,
) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' })
    .setIssuer(`pston:${issuer}`)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttl)
    .setJti(randomUUID())
    .sign(await privateKey(issuer));
}
export async function verifyToken(token: string, audience: string, issuers: ServiceName[]) {
  try {
    const issuer = decodeJwt(token).iss?.replace('pston:', '');
    if (!issuer || !issuers.includes(issuer as ServiceName)) throw new Error('issuer');
    return (
      await jwtVerify(token, await publicKey(issuer), {
        algorithms: ['EdDSA'],
        audience,
        issuer: `pston:${issuer}`,
        clockTolerance: 2,
      })
    ).payload;
  } catch {
    throw new AppError(401, 'INVALID_TOKEN', 'Service or approval token is invalid or expired');
  }
}
export function bearer(header?: string) {
  if (!header?.startsWith('Bearer '))
    throw new AppError(401, 'SERVICE_AUTH_REQUIRED', 'Service authentication required');
  return header.slice(7);
}
