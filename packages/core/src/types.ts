export type ServiceName = 'gateway' | 'identity' | 'documents' | 'signing' | 'audit';
export interface User {
  id: string;
  name: string;
  email: string;
  mode: 'demo' | 'google';
}
export interface Session {
  user: User;
  csrf: string;
  mode: 'demo' | 'google';
  passkeys: number;
}
export interface Element {
  id: string;
  type: 'text' | 'date' | 'stamp' | 'signature';
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  color: string;
  text: string;
  image?: string;
}
export interface Revision {
  id: string;
  kind: 'original' | 'signed';
  sha256: string;
  bytes: number;
  createdAt: string;
  requestId?: string;
  verificationId?: string;
}
export interface DocumentRecord {
  id: string;
  owner: string;
  title: string;
  bytes: number;
  pages: number;
  createdAt: string;
  updatedAt: string;
  status: 'draft' | 'signed';
  draftVersion: number;
  elements: Element[];
  revisions: Revision[];
  deletedAt?: string;
}
export interface CertificateProfile {
  id: string;
  owner: string;
  label: string;
  subject: string;
  issuer: string;
  serial: string;
  fingerprint: string;
  validFrom: string;
  validTo: string;
  algorithm: string;
  provider: 'demo' | 'certificate-only' | 'tdid';
  canSign: boolean;
  testOnly: boolean;
}
export interface SigningRequest {
  id: string;
  owner: string;
  documentId: string;
  certificateId: string;
  draftVersion: number;
  previewId: string;
  previewHash: string;
  preparedHash: string;
  documentDigest: string;
  nonce: string;
  createdAt: string;
  expiresAt: string;
  state: 'prepared' | 'signing' | 'signed' | 'failed' | 'pending_review' | 'expired';
  verificationId?: string;
  qr: boolean;
  revision?: Revision;
  error?: string;
  approvalEvidenceHash?: string;
  attemptId?: string;
}
export interface AuditEvent {
  id: string;
  owner: string;
  type: string;
  service: ServiceName;
  occurredAt: string;
  resourceId: string;
  outcome: 'success' | 'failure';
  details: Record<string, string | number | boolean>;
}
export interface AuditRecord extends AuditEvent {
  sequence: number;
  previousHash: string;
  hash: string;
}
