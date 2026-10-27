import { it, expect } from 'vitest';
import {
  acceptGoogleClaims,
  sessionUserAllowed,
} from '../../services/identity/src/google-policy.js';
import { readGoogleAllowlist } from '../../packages/core/src/google-allowlist.mjs';

const claims = {
  sub: '123456789012345678901',
  email: 'owner@gmail.com',
  email_verified: true,
  nonce: 'browser-nonce',
  azp: 'web-client',
};
const allowlist = readGoogleAllowlist({
  GOOGLE_ALLOWED_EMAILS: ' Owner@Gmail.COM , second@example.test, owner@gmail.com',
});
const expected = { nonce: 'browser-nonce', clientId: 'web-client', allowlist };

it('authorizes exact verified Gmail and Workspace emails but retains sub as the owner ID', () => {
  expect(allowlist.emails).toEqual(['owner@gmail.com', 'second@example.test']);
  expect(acceptGoogleClaims(claims, expected)).toBe(claims.sub);
  expect(acceptGoogleClaims({ ...claims, email: 'OWNER@GMAIL.COM' }, expected)).toBe(claims.sub);
  expect(
    acceptGoogleClaims({ ...claims, email: 'second@example.test', hd: 'example.test' }, expected),
  ).toBe(claims.sub);
  // Email reassignment never maps a new Google account to the previous sub's vault.
  expect(acceptGoogleClaims({ ...claims, sub: '987654321098765432109' }, expected)).toBe(
    '987654321098765432109',
  );
});

it('rejects unverified or unlisted email, forged login context and unproven third-party mailbox ownership', () => {
  for (const change of [
    { nonce: 'another-browser' },
    { email_verified: false },
    { email_verified: 'true' },
    { azp: 'another-client' },
    { sub: '' },
    { email: undefined },
    { email: 'unlisted@gmail.com' },
    { email: 'owner+alias@gmail.com' },
    { email: 'o.wner@gmail.com' },
    { email: 'owner@gmail.com.attacker.test', hd: 'attacker.test' },
    { email: 'second@example.test' },
  ])
    expect(() => acceptGoogleClaims({ ...claims, ...change }, expected)).toThrow();
});

it('rejects invalid lists and prevents a legacy sub from bypassing configured or emptied emails', () => {
  for (const value of [
    '*',
    '*@gmail.com',
    '@gmail.com',
    'owner@gmail.com,',
    'owner@gmail.com;other@gmail.com',
    'not-an-email',
  ])
    expect(() =>
      readGoogleAllowlist({ GOOGLE_ALLOWED_EMAILS: value, GOOGLE_ALLOWED_SUBS: claims.sub }),
    ).toThrow();
  const removed = readGoogleAllowlist({
    GOOGLE_ALLOWED_EMAILS: 'second@example.test',
    GOOGLE_ALLOWED_SUBS: claims.sub,
  });
  expect(() => acceptGoogleClaims(claims, { ...expected, allowlist: removed })).toThrow();
  const empty = readGoogleAllowlist({ GOOGLE_ALLOWED_EMAILS: '', GOOGLE_ALLOWED_SUBS: claims.sub });
  expect(empty).toEqual({ emails: [], subjects: [] });
  expect(() => acceptGoogleClaims(claims, { ...expected, allowlist: empty })).toThrow();
});

it('supports existing sub-only deployments while rejecting another sub even with the same email', () => {
  const legacy = {
    ...expected,
    allowlist: readGoogleAllowlist({ GOOGLE_ALLOWED_SUBS: claims.sub }),
  };
  expect(acceptGoogleClaims(claims, legacy)).toBe(claims.sub);
  expect(() => acceptGoogleClaims({ ...claims, sub: 'other-sub' }, legacy)).toThrow();
});

it('invalidates sessions when email is removed and requires fresh login when switching from sub-only authorization', () => {
  const user = { id: claims.sub, name: 'Owner', email: 'OWNER@GMAIL.COM', mode: 'google' as const };
  expect(sessionUserAllowed(user, 'google', allowlist, true)).toBe(true);
  expect(sessionUserAllowed(user, 'google', allowlist)).toBe(false);
  expect(
    sessionUserAllowed(
      user,
      'google',
      { emails: ['second@example.test'], subjects: [user.id] },
      true,
    ),
  ).toBe(false);
  expect(sessionUserAllowed(user, 'google', { emails: [], subjects: [] }, true)).toBe(false);
  expect(sessionUserAllowed(user, 'demo', allowlist, true)).toBe(false);
  expect(sessionUserAllowed({ ...user, mode: 'demo' }, 'google', allowlist, true)).toBe(false);
  expect(sessionUserAllowed(user, 'google', { emails: [], subjects: [user.id] })).toBe(true);
});
