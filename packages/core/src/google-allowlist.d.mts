export interface GoogleAllowlist {
  emails: string[];
  subjects: string[];
}
export function normalizeGoogleEmail(value: unknown): string | null;
export function readGoogleAllowlist(env: Record<string, string | undefined>): GoogleAllowlist;
