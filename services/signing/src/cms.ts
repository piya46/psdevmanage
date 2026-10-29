import forge from 'node-forge';
import { createHash } from 'node:crypto';

const a = forge.asn1;
const seq = (v: forge.asn1.Asn1[]) => a.create(a.Class.UNIVERSAL, a.Type.SEQUENCE, true, v);
const set = (v: forge.asn1.Asn1[]) =>
  a.create(
    a.Class.UNIVERSAL,
    a.Type.SET,
    true,
    [...v].sort((x, y) => Buffer.compare(der(x), der(y))),
  );
const oid = (v: string) => a.create(a.Class.UNIVERSAL, a.Type.OID, false, a.oidToDer(v).getBytes());
const octet = (v: Buffer) =>
  a.create(a.Class.UNIVERSAL, a.Type.OCTETSTRING, false, v.toString('binary'));
const integer = (v: number) =>
  a.create(a.Class.UNIVERSAL, a.Type.INTEGER, false, a.integerToDer(v).getBytes());
const context = (tag: number, v: forge.asn1.Asn1[]) =>
  a.create(a.Class.CONTEXT_SPECIFIC, tag, true, v);
const der = (v: forge.asn1.Asn1) => Buffer.from(a.toDer(v).getBytes(), 'binary');
const hash = (v: Buffer) => createHash('sha256').update(v).digest();
const sha256 = () =>
  seq([oid('2.16.840.1.101.3.4.2.1'), a.create(a.Class.UNIVERSAL, a.Type.NULL, false, '')]);
const attr = (id: string, value: forge.asn1.Asn1) => seq([oid(id), set([value])]);

/** Detached CMS/CAdES with signed content digest and SigningCertificateV2 binding. */
export async function createDetachedCms(
  content: Buffer,
  chain: string[],
  signingTime: Date,
  signAttributes: (data: Buffer) => Promise<Buffer>,
) {
  const certs = chain.map((pem) => a.fromDer(forge.pem.decode(pem)[0].body));
  const tbs = (certs[0].value as forge.asn1.Asn1[])[0].value as forge.asn1.Asn1[];
  const offset = tbs[0].tagClass === a.Class.CONTEXT_SPECIFIC ? 1 : 0;
  const issuerAndSerial = seq([tbs[offset + 2], tbs[offset]]);
  const time =
    signingTime.getUTCFullYear() < 2050
      ? a.create(a.Class.UNIVERSAL, a.Type.UTCTIME, false, a.dateToUtcTime(signingTime))
      : a.create(
          a.Class.UNIVERSAL,
          a.Type.GENERALIZEDTIME,
          false,
          a.dateToGeneralizedTime(signingTime),
        );
  const attributes = set([
    attr('1.2.840.113549.1.9.3', oid('1.2.840.113549.1.7.1')),
    attr('1.2.840.113549.1.9.4', octet(hash(content))),
    attr('1.2.840.113549.1.9.5', time),
    attr('1.2.840.113549.1.9.16.2.47', seq([seq([seq([octet(hash(der(certs[0])))])])])),
  ]);
  // RFC 5652: sign DER SET OF (0x31), then embed as IMPLICIT [0] (0xa0).
  const signature = await signAttributes(der(attributes));
  const signer = seq([
    integer(1),
    issuerAndSerial,
    sha256(),
    context(0, attributes.value as forge.asn1.Asn1[]),
    seq([oid('1.2.840.113549.1.1.1'), a.create(a.Class.UNIVERSAL, a.Type.NULL, false, '')]),
    octet(signature),
  ]);
  return der(
    seq([
      oid('1.2.840.113549.1.7.2'),
      context(0, [
        seq([
          integer(1),
          set([sha256()]),
          seq([oid('1.2.840.113549.1.7.1')]),
          context(
            0,
            [...certs].sort((x, y) => Buffer.compare(der(x), der(y))),
          ),
          set([signer]),
        ]),
      ]),
    ]),
  );
}
