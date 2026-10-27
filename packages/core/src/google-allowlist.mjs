/** Match an exact mailbox. Do not merge dots, plus aliases or domains. */
export function normalizeGoogleEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  const [local, domain, extra] = email.split('@');
  if (
    extra !== undefined ||
    !local ||
    !domain ||
    local.length > 64 ||
    domain.length > 253 ||
    !/^[a-z0-9.!#$%&'+/=?^_`{|}~-]+$/.test(local) ||
    local.startsWith('.') ||
    local.endsWith('.') ||
    local.includes('..') ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(domain)
  )
    return null;
  return email;
}

export function readGoogleAllowlist(env) {
  if (env.GOOGLE_ALLOWED_EMAILS !== undefined) {
    if (!env.GOOGLE_ALLOWED_EMAILS.trim()) return { emails: [], subjects: [] };
    const emails = env.GOOGLE_ALLOWED_EMAILS.split(',').map(normalizeGoogleEmail);
    if (emails.some((email) => email === null))
      throw new Error(
        'GOOGLE_ALLOWED_EMAILS must contain exact email addresses separated by commas; wildcards are not allowed',
      );
    // Email configuration takes precedence, so a stale legacy sub cannot keep
    // access after its email is removed from the configured allowlist.
    return { emails: [...new Set(emails)], subjects: [] };
  }
  const subjects = env.GOOGLE_ALLOWED_SUBS?.trim()
    ? env.GOOGLE_ALLOWED_SUBS.split(',').map((value) => value.trim())
    : [];
  if (!subjects.every((sub) => /^\d{10,255}$/.test(sub)))
    throw new Error(
      'Set GOOGLE_ALLOWED_EMAILS to your Google email, or provide valid legacy GOOGLE_ALLOWED_SUBS',
    );
  return { emails: [], subjects: [...new Set(subjects)] };
}
