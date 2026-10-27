import { ensure } from '../../../packages/core/src/errors.js';
import type { User } from '../../../packages/core/src/types.js';
import {
  normalizeGoogleEmail,
  type GoogleAllowlist,
} from '../../../packages/core/src/google-allowlist.mjs';

/** Called only after JOSE verifies Google's signature, issuer, audience and expiry. */
export function acceptGoogleClaims(
  payload: Record<string, unknown>,
  expected: { nonce: string; clientId: string; allowlist: GoogleAllowlist },
) {
  ensure(
    payload.nonce === expected.nonce &&
      typeof payload.sub === 'string' &&
      payload.sub.length > 0 &&
      normalizeGoogleEmail(payload.email) !== null &&
      payload.email_verified === true &&
      (payload.azp === undefined || payload.azp === expected.clientId),
    401,
    'INVALID_IDENTITY',
    'Google identity mismatch',
  );
  const email = normalizeGoogleEmail(payload.email)!;
  if (expected.allowlist.emails.length) {
    // Google is authoritative for Gmail and managed Workspace identities.
    // A third-party mailbox needs a separate ownership challenge.
    ensure(
      email.endsWith('@gmail.com') ||
        (typeof payload.hd === 'string' && payload.hd.trim().length > 0),
      403,
      'EMAIL_OWNERSHIP_REQUIRED',
      'Email allowlist รองรับ Gmail หรือ Google Workspace ที่ยืนยันแล้ว',
    );
  }
  ensure(
    expected.allowlist.emails.length
      ? expected.allowlist.emails.includes(email)
      : expected.allowlist.subjects.includes(payload.sub as string),
    403,
    'ACCOUNT_NOT_ALLOWED',
    'บัญชี Google นี้ยังไม่ได้รับอนุญาต',
  );
  return payload.sub as string;
}

export function sessionUserAllowed(
  user: User,
  mode: string,
  allowlist: GoogleAllowlist,
  emailAuthorized = false,
) {
  if (user.mode !== mode) return false;
  if (mode === 'demo') return true;
  return allowlist.emails.length
    ? emailAuthorized && allowlist.emails.includes(normalizeGoogleEmail(user.email) ?? '')
    : allowlist.subjects.includes(user.id);
}
