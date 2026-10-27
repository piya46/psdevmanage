import {
  PDFDocument,
  PDFDict,
  PDFArray,
  PDFRef,
  PDFRawStream,
  PDFName,
  PDFObject,
  type PDFPage,
  degrees,
  rgb,
} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { readFile } from 'node:fs/promises';
import QRCode from 'qrcode';
import { pdflibAddPlaceholder } from '@signpdf/placeholder-pdf-lib';
import { SUBFILTER_ETSI_CADES_DETACHED } from '@signpdf/utils';
import type { Element } from '../../../packages/core/src/types.js';

interface Input {
  operation: 'inspect' | 'compose' | 'prepare' | 'sample';
  pdf?: string;
  elements?: Element[];
  qr?: string;
  testOnly?: boolean;
  name?: string;
  createdAt?: string;
}
function viewport(page: PDFPage) {
  const crop = page.getCropBox();
  const rotation = ((page.getRotation().angle % 360) + 360) % 360;
  const vw = rotation % 180 ? crop.height : crop.width,
    vh = rotation % 180 ? crop.width : crop.height;
  const point = (u: number, v: number) =>
    rotation === 90
      ? { x: crop.x + v, y: crop.y + u }
      : rotation === 180
        ? { x: crop.x + crop.width - u, y: crop.y + v }
        : rotation === 270
          ? { x: crop.x + crop.width - v, y: crop.y + crop.height - u }
          : { x: crop.x + u, y: crop.y + crop.height - v };
  return { vw, vh, point, rotate: degrees(rotation) };
}
let raw = '';
for await (const chunk of process.stdin) {
  raw += chunk;
  if (raw.length > 80 * 1024 * 1024) throw new Error('INPUT_TOO_LARGE');
}
const input = JSON.parse(raw) as Input;
const pdf =
  input.operation === 'sample'
    ? await PDFDocument.create()
    : await PDFDocument.load(Buffer.from(input.pdf!, 'base64'), {
        ignoreEncryption: false,
        updateMetadata: false,
        throwOnInvalidObject: true,
      });
if (pdf.getPageCount() > 300) throw new Error('PDF_TOO_MANY_PAGES');
if (input.operation !== 'sample' && pdf.getPageCount() === 0) throw new Error('PDF_EMPTY');
if (input.operation === 'inspect') {
  const visited = new Set<PDFObject>();
  function inspectObject(object: PDFObject, depth = 0) {
    if (visited.has(object)) return;
    visited.add(object);
    if (visited.size > 100000 || depth > 100) throw new Error('PDF_COMPLEXITY_LIMIT');
    if (object instanceof PDFRef) {
      const resolved = pdf.context.lookup(object);
      if (resolved) inspectObject(resolved, depth + 1);
    }
    if (object instanceof PDFRawStream) inspectObject(object.dict, depth + 1);
    if (object instanceof PDFArray)
      for (const item of object.asArray()) inspectObject(item, depth + 1);
    if (object instanceof PDFDict)
      for (const key of object.keys()) {
        if (
          [
            'JavaScript',
            'JS',
            'OpenAction',
            'AA',
            'Launch',
            'EmbeddedFiles',
            'RichMedia',
            'XFA',
            'ByteRange',
          ].includes(key.asString().slice(1))
        )
          throw new Error('PDF_ACTIVE_OR_SIGNED_CONTENT_UNSUPPORTED');
        if (
          key === PDFName.of('S') &&
          ['/JavaScript', '/Launch', '/GoToR', '/SubmitForm', '/ImportData'].includes(
            object.get(key)?.toString() ?? '',
          )
        )
          throw new Error('PDF_ACTIVE_CONTENT');
        const value = object.get(key);
        if (value) inspectObject(value, depth + 1);
      }
  }
  for (const [, object] of pdf.context.enumerateIndirectObjects()) inspectObject(object);
  for (const page of pdf.getPages()) {
    const box = page.getCropBox();
    if (![box.width, box.height].every((n) => Number.isFinite(n) && n > 0 && n <= 20000))
      throw new Error('PDF_PAGE_SIZE_LIMIT');
  }
  process.stdout.write(JSON.stringify({ pages: pdf.getPageCount() }));
} else if (input.operation === 'prepare') {
  pdflibAddPlaceholder({
    pdfDoc: pdf,
    reason: 'PSTON explicit transaction approval — TEST ONLY',
    contactInfo: '',
    name: input.name ?? 'PSTON TEST',
    location: '',
    signingTime: new Date(input.createdAt!),
    signatureLength: 16384,
    widgetRect: [0, 0, 0, 0],
    appName: 'PSTON',
    subFilter: SUBFILTER_ETSI_CADES_DETACHED,
  });
  process.stdout.write(
    JSON.stringify({
      pdf: Buffer.from(await pdf.save({ useObjectStreams: false, addDefaultPage: false })).toString(
        'base64',
      ),
    }),
  );
} else {
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(await readFile('assets/fonts/NotoSansThai.ttf'), {
    subset: true,
  });
  if (input.operation === 'sample') {
    const p = pdf.addPage([595.28, 841.89]);
    p.drawRectangle({ x: 0, y: 760, width: 595.28, height: 82, color: rgb(0.06, 0.23, 0.19) });
    p.drawText('PSTON', { x: 48, y: 790, size: 24, font, color: rgb(1, 1, 1) });
    p.drawText('เอกสารตัวอย่างสำหรับทดลองใช้งาน', {
      x: 48,
      y: 708,
      size: 24,
      font,
      color: rgb(0.1, 0.2, 0.18),
    });
    p.drawText('เลขที่เอกสาร PSTON-DEMO-001', {
      x: 48,
      y: 670,
      size: 12,
      font,
      color: rgb(0.4, 0.45, 0.44),
    });
    const lines = [
      'เรื่อง  ทดสอบการจัดการเอกสารและลงลายมือชื่อดิจิทัล',
      'เรียน  เจ้าของระบบ PSTON',
      '',
      'เอกสารนี้จัดทำขึ้นเพื่อทดสอบการอัปโหลด การจัดวางข้อความ',
      'วันที่ ตราประทับ และภาพลายเซ็น ก่อนสร้างลายเซ็นดิจิทัล',
      '',
      'คุณสามารถเพิ่มข้อความในพื้นที่ว่าง ตรวจสอบเอกสารฉบับสุดท้าย',
      'แล้วอนุมัติการลงนามเป็นรายธุรกรรมได้',
      '',
      'เอกสารทดลองและใบรับรองทดสอบนี้ไม่ใช่ใบรับรอง TDID',
      'และไม่ได้รับรองความน่าเชื่อถือของผู้ลงนามจาก CA ภายนอก',
    ];
    lines.forEach((line, i) =>
      p.drawText(line, { x: 48, y: 620 - i * 27, size: 14, font, color: rgb(0.19, 0.23, 0.22) }),
    );
    p.drawLine({
      start: { x: 350, y: 190 },
      end: { x: 530, y: 190 },
      thickness: 1,
      color: rgb(0.6, 0.65, 0.62),
    });
    p.drawText('พื้นที่ลงนาม', { x: 405, y: 165, size: 12, font, color: rgb(0.45, 0.5, 0.48) });
    p.drawText('เอกสารตัวอย่าง • ไม่มีข้อมูลส่วนบุคคลจริง', {
      x: 48,
      y: 65,
      size: 10,
      font,
      color: rgb(0.45, 0.5, 0.48),
    });
  } else {
    for (const el of input.elements ?? []) {
      const page = pdf.getPage(el.page);
      const { vw, vh, point, rotate } = viewport(page);
      const color = rgb(
        parseInt(el.color.slice(1, 3), 16) / 255,
        parseInt(el.color.slice(3, 5), 16) / 255,
        parseInt(el.color.slice(5, 7), 16) / 255,
      );
      if (el.type === 'signature' && el.image) {
        const image = await pdf.embedPng(Buffer.from(el.image.split(',')[1], 'base64'));
        const pos = point(el.x * vw, (el.y + el.height) * vh);
        page.drawImage(image, { ...pos, width: el.width * vw, height: el.height * vh, rotate });
      } else {
        const pos = point(el.x * vw, el.y * vh + el.fontSize);
        page.drawText(el.text, {
          ...pos,
          font,
          size: el.fontSize,
          color,
          rotate,
          maxWidth: el.width * vw,
          lineHeight: el.fontSize * 1.35,
        });
        if (el.type === 'stamp') {
          const border = point(el.x * vw - 6, (el.y + el.height) * vh + 5);
          page.drawRectangle({
            ...border,
            width: el.width * vw + 12,
            height: el.height * vh + 10,
            borderColor: color,
            borderWidth: 1.3,
            rotate,
          });
        }
      }
    }
    if (input.qr) {
      const page = pdf.getPage(0);
      const { vw, vh, point, rotate } = viewport(page);
      if (vw < 120 || vh < 150) throw new Error('PDF_PAGE_TOO_SMALL_FOR_QR');
      const image = await pdf.embedPng(await QRCode.toBuffer(input.qr, { width: 240, margin: 1 }));
      page.drawRectangle({
        ...point(vw - 100, vh - 35),
        rotate,
        width: 80,
        height: 80,
        color: rgb(1, 1, 1),
      });
      page.drawImage(image, { ...point(vw - 96, vh - 39), rotate, width: 72, height: 72 });
    }
    if (input.testOnly)
      for (const page of pdf.getPages()) {
        const { vw, vh, point, rotate } = viewport(page);
        page.drawRectangle({
          ...point(0, vh),
          rotate,
          width: vw,
          height: 22,
          color: rgb(1, 0.96, 0.88),
        });
        page.drawText('PSTON TEST ONLY | Self-signed test certificate | NOT TDID', {
          ...point(12, vh - 7),
          rotate,
          size: 7,
          font,
          color: rgb(0.5, 0.27, 0.1),
        });
      }
  }
  pdf.setProducer('PSTON');
  pdf.setCreator('PSTON');
  process.stdout.write(
    JSON.stringify({
      pdf: Buffer.from(await pdf.save({ useObjectStreams: false, addDefaultPage: false })).toString(
        'base64',
      ),
      pages: pdf.getPageCount(),
    }),
  );
}
