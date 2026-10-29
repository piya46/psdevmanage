import forge from 'node-forge';
import { aeskwp } from '@noble/ciphers/aes.js';

const bytes = (binary: string) => Uint8Array.from(binary, (c) => c.charCodeAt(0));
const binary = (value: Uint8Array) => Array.from(value, (b) => String.fromCharCode(b)).join('');
export interface P12Metadata {
  pem: string;
  subject: string;
  validTo: string;
  algorithm: string;
}

/** Runs in a disposable worker. Neither private material nor passwords leave it. */
export class P12Session {
  private key: forge.pki.rsa.PrivateKey | undefined;
  readonly metadata: P12Metadata;
  constructor(input: ArrayBuffer, password: string, at = new Date()) {
    if (input.byteLength > 2 * 1024 * 1024) throw new Error('ไฟล์ P12/PFX ต้องไม่เกิน 2 MB');
    let p12: forge.pkcs12.Pkcs12Pfx;
    try {
      const parsed = forge.asn1.fromDer(binary(new Uint8Array(input)), true);
      if (!Array.isArray(parsed.value) || parsed.value.length !== 3)
        throw new Error('PKCS#12 integrity MAC is required');
      p12 = forge.pkcs12.pkcs12FromAsn1(parsed, true, password);
    } catch {
      throw new Error('อ่าน P12 ไม่ได้: ตรวจรหัสผ่านและรูปแบบไฟล์');
    }
    const bags = p12.safeContents.flatMap((c) => c.safeBags);
    const keys = bags.filter((b) =>
      [forge.pki.oids.keyBag, forge.pki.oids.pkcs8ShroudedKeyBag].includes(b.type),
    );
    if (keys.length !== 1 || !keys[0].key || !('n' in keys[0].key))
      throw new Error('ไฟล์ต้องมี Private Key แบบ RSA เพียงหนึ่งกุญแจ');
    const key = keys[0].key as forge.pki.rsa.PrivateKey;
    const matching = bags
      .map((b) => b.cert)
      .filter((c): c is forge.pki.Certificate => {
        if (!c || !('n' in c.publicKey)) return false;
        return c.publicKey.n.equals(key.n) && c.publicKey.e.equals(key.e);
      });
    if (matching.length !== 1) throw new Error('ใบรับรองไม่ตรงกับ Private Key หรือมีใบรับรองซ้ำ');
    const cert = matching[0];
    if (at < cert.validity.notBefore || at >= cert.validity.notAfter)
      throw new Error('ใบรับรองหมดอายุหรือยังไม่ถึงวันเริ่มใช้');
    if (![2048, 3072, 4096].includes(key.n.bitLength()) || key.e.toString() !== '65537')
      throw new Error('รองรับ RSA 2048, 3072 หรือ 4096 บิต');
    this.key = key;
    this.metadata = {
      pem: forge.pki.certificateToPem(cert),
      subject: cert.subject.attributes.map((a) => `${a.shortName ?? a.name}=${a.value}`).join(', '),
      validTo: cert.validity.notAfter.toISOString(),
      algorithm: `RSA_SIGN_PKCS1_${key.n.bitLength()}_SHA256`,
    };
  }
  async wrap(importJobPublicKey: string): Promise<string> {
    if (!this.key) throw new Error('รายการนี้ถูกใช้แล้ว กรุณาเลือกไฟล์ใหม่');
    const key = this.key;
    this.key = undefined;
    const publicKey = forge.pki.publicKeyFromPem(importJobPublicKey) as forge.pki.rsa.PublicKey;
    if (publicKey.n.bitLength() !== 3072 || publicKey.e.toString() !== '65537')
      throw new Error('กุญแจนำเข้าของ HSM ไม่ตรงกับรูปแบบที่รองรับ');
    const pkcs8 = bytes(
      forge.asn1.toDer(forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(key))).getBytes(),
    );
    const kek = crypto.getRandomValues(new Uint8Array(32));
    try {
      const spki = bytes(forge.asn1.toDer(forge.pki.publicKeyToAsn1(publicKey)).getBytes());
      const wrappingKey = await crypto.subtle.importKey(
        'spki',
        spki,
        { name: 'RSA-OAEP', hash: 'SHA-256' },
        false,
        ['encrypt'],
      );
      const wrappedKek = new Uint8Array(
        await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, wrappingKey, kek),
      );
      const wrappedKey = aeskwp(kek).encrypt(pkcs8);
      const payload = new Uint8Array(wrappedKek.length + wrappedKey.length);
      payload.set(wrappedKek);
      payload.set(wrappedKey, wrappedKek.length);
      return forge.util.encode64(binary(payload));
    } finally {
      pkcs8.fill(0);
      kek.fill(0);
    }
  }
}
