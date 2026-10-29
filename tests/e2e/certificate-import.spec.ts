import { test, expect } from '@playwright/test';
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  privateDecrypt,
  constants,
  createDecipheriv,
  X509Certificate,
} from 'node:crypto';
import { signingFixture } from '../fixtures/signing.js';

test('P12 upload runs in browser worker and sends only public certificate and wrapped key', async ({
  page,
}) => {
  const fixture = signingFixture();
  const wrapping = generateKeyPairSync('rsa', { modulusLength: 3072 });
  const bodies: string[] = [];
  let id = '',
    submitted = false;
  try {
    await page.goto('/');
    await page.getByRole('button', { name: /เปิดพื้นที่ทดลอง/ }).click();
    // Only the cloud import API is simulated. File parsing, worker, crypto and UI run in Chrome.
    await page.route('**/api/certificates', async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      await route.fulfill({
        json: { ...data, provider: { configured: true, message: 'พร้อมนำเข้า P12' } },
      });
    });
    await page.route('**/api/certificates/imports**', async (route) => {
      const request = route.request();
      if (request.method() === 'POST') {
        bodies.push(request.postData() ?? '');
        const body = request.postDataJSON();
        if (body.pem) {
          id = body.idempotencyKey;
          expect(new X509Certificate(body.pem).raw).toEqual(new X509Certificate(fixture.pem).raw);
          await route.fulfill({ json: { id, state: 'wrapping' } });
        } else {
          expect(Object.keys(body)).toEqual(['wrappedKey']);
          const wrapped = Buffer.from(body.wrappedKey, 'base64');
          const kek = privateDecrypt(
            {
              key: wrapping.privateKey,
              padding: constants.RSA_PKCS1_OAEP_PADDING,
              oaepHash: 'sha256',
            },
            wrapped.subarray(0, 384),
          );
          const decipher = createDecipheriv(
            'id-aes256-wrap-pad',
            kek,
            Buffer.from('a65959a6', 'hex'),
          );
          const der = Buffer.concat([decipher.update(wrapped.subarray(384)), decipher.final()]);
          expect(
            createPublicKey(createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })).export({
              type: 'spki',
              format: 'der',
            }),
          ).toEqual(
            new X509Certificate(fixture.pem).publicKey.export({ type: 'spki', format: 'der' }),
          );
          submitted = true;
          await route.fulfill({ json: { id, state: 'importing' } });
        }
      } else
        await route.fulfill({
          json: request.url().endsWith('/imports')
            ? { imports: [] }
            : {
                id,
                state: submitted ? 'ready' : 'wrapping',
                publicKey: wrapping.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
              },
        });
    });
    await page.getByRole('navigation').getByRole('button', { name: 'ใบรับรองของฉัน' }).click();
    await page.getByRole('button', { name: 'นำเข้า P12 สำหรับลงนาม' }).click();
    const dialog = page.getByRole('dialog', { name: 'นำเข้าใบรับรองสำหรับลงนาม' });
    await dialog
      .getByLabel('ไฟล์ใบรับรอง')
      .setInputFiles({
        name: 'fixture.p12',
        mimeType: 'application/x-pkcs12',
        buffer: fixture.p12,
      });
    await dialog.getByLabel('รหัสผ่านไฟล์').fill('wrong-password');
    await dialog.getByRole('checkbox').check();
    await dialog.getByRole('button', { name: 'นำเข้าใบรับรองสำหรับลงนาม' }).click();
    await expect(dialog.getByRole('alert')).toContainText('รหัสผ่าน');
    expect(bodies).toHaveLength(0);
    await dialog.getByLabel('รหัสผ่านไฟล์').fill('fixture-only-password');
    await dialog.getByRole('button', { name: 'นำเข้าใบรับรองสำหรับลงนาม' }).click();
    await expect(page.getByRole('status')).toContainText('นำเข้าใบรับรองและเชื่อมกุญแจ HSM สำเร็จ');
    expect(submitted).toBe(true);
    expect(bodies).toHaveLength(2);
    expect(bodies.join('')).not.toMatch(/fixture-only-password|wrong-password|PRIVATE KEY/);
  } finally {
    fixture.cleanup();
  }
});
