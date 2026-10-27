import { test, expect } from '@playwright/test';
import { PDFDocument, degrees } from 'pdf-lib';

test('Thai workspace, PDF editing, WebAuthn approval, signed download and public verification', async ({
  page,
  context,
  baseURL,
}, testInfo) => {
  const errors: string[] = [];
  let approvalBody: unknown;
  page.on('request', (request) => {
    if (request.url().endsWith('/api/approval/verify')) approvalBody = request.postDataJSON();
  });
  page.on('pageerror', (error) => errors.push(error.message));
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: /เปิดพื้นที่ทดลอง/ })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('01-login.png'), fullPage: true });
  await page.getByRole('button', { name: /เปิดพื้นที่ทดลอง/ }).click();
  await expect(page.getByRole('heading', { name: 'เอกสารของคุณ.' })).toBeVisible();
  await page.getByRole('navigation').getByRole('button', { name: 'ศูนย์ความปลอดภัย' }).click();
  await page.getByRole('button', { name: 'ลงทะเบียน Passkey', exact: true }).click();
  await expect(page.getByText('ลงทะเบียนแล้ว', { exact: true })).toBeVisible();
  await page
    .getByRole('navigation')
    .getByRole('button', { name: /เอกสารทั้งหมด/ })
    .click();
  await page.getByRole('button', { name: 'ใช้เอกสารตัวอย่าง', exact: true }).click();
  await expect(page.locator('.editor-shell canvas')).toBeVisible();
  await expect(page.locator('.pdf-loading')).toHaveCount(0);
  await page.getByRole('button', { name: 'ข้อความ ไทย / อังกฤษ' }).click();
  await page
    .getByRole('textbox', { name: 'ข้อความ', exact: true })
    .fill('อนุมัติเอกสารทดสอบ ภาษาไทย');
  await page.getByRole('spinbutton', { name: 'ตำแหน่ง Y (%)' }).fill('74');
  await page.getByRole('checkbox', { name: 'เพิ่ม QR สำหรับตรวจสอบ' }).check();
  await expect(page.getByText('บันทึกการเปลี่ยนแปลงแล้ว')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('02-editor.png'), fullPage: true });
  await page.getByRole('button', { name: 'ตรวจเอกสารและลงนาม' }).click();
  const dialog = page.getByRole('dialog', { name: 'ตรวจเอกสารก่อนลงนาม' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.pdf-loading')).toHaveCount(0);
  await expect(dialog.getByRole('checkbox', { name: 'อนุมัติด้วย Passkey' })).toBeChecked();
  await dialog
    .getByRole('checkbox', { name: 'ตรวจเอกสารฉบับนี้แล้ว และยืนยันการลงนามทดสอบ' })
    .check();
  await page.screenshot({ path: testInfo.outputPath('03-final-review.png'), fullPage: true });
  await dialog.getByRole('button', { name: 'ลงนามทดสอบ', exact: true }).click();
  await expect(page.getByText('ฉบับลงนาม · เปิดอ่านอย่างเดียว')).toBeVisible();
  const replayStatus = await page.evaluate(async (body) => {
    const session = await (await fetch('/api/session')).json();
    const response = await fetch('/api/approval/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': session.csrf },
      body: JSON.stringify(body),
    });
    return response.status;
  }, approvalBody);
  expect(replayStatus).toBe(401);
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'ดาวน์โหลด PDF' }).click();
  expect((await downloaded).suggestedFilename()).toContain('.pdf');
  await page.getByRole('button', { name: 'ตรวจลายเซ็น', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('ตรวจสอบลายเซ็นและ Hash ผ่าน');
  await page.getByRole('button', { name: 'กลับไปเอกสาร' }).click();
  await expect(page.locator('.documents-table')).toContainText('ลงนามทดสอบแล้ว');
  await page.screenshot({ path: testInfo.outputPath('04-workspace.png'), fullPage: true });
  const { documents } = await (await page.request.get('/api/documents')).json();
  const latest = documents[0].revisions.at(-1);
  const anonymous = await context.browser()!.newContext();
  const publicPage = await anonymous.newPage();
  await publicPage.goto(baseURL + '/verify/' + latest.verificationId);
  await expect(publicPage.getByText(latest.sha256, { exact: true })).toBeVisible();
  expect(
    (await anonymous.request.get(baseURL + '/api/documents/' + documents[0].id)).status(),
  ).toBe(401);
  await anonymous.close();
  expect(errors).toEqual([]);
});

test('mobile document workspace stays within the viewport', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: /เปิดพื้นที่ทดลอง/ }).click();
  await expect(page.getByRole('heading', { name: 'เอกสารของคุณ.' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('05-mobile.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole('button', { name: 'เปิดเมนู' }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'ใบรับรองของฉัน' }).click();
  await expect(page.getByRole('heading', { name: 'ใบรับรองของฉัน.' })).toBeVisible();
});

test('upload and preview a rotated PDF with a non-zero crop box', async ({ page }, testInfo) => {
  const source = await PDFDocument.create();
  const sheet = source.addPage([600, 800]);
  sheet.setCropBox(50, 70, 400, 600);
  sheet.setRotation(degrees(90));
  await page.goto('/');
  await page.getByRole('button', { name: 'เปิดพื้นที่ทดลอง' }).click();
  await page.locator('input[type="file"]').setInputFiles({
    name: 'rotated-crop.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await source.save()),
  });
  await expect(page.locator('.editor-shell canvas')).toBeVisible();
  await expect(page.locator('.pdf-loading')).toHaveCount(0);
  await page.getByRole('button', { name: 'ข้อความ ไทย / อังกฤษ' }).click();
  await page
    .getByRole('textbox', { name: 'ข้อความ', exact: true })
    .fill('ข้อความบนหน้าหมุน · ROTATED CROP TEST');
  await page.getByRole('checkbox', { name: 'เพิ่ม QR สำหรับตรวจสอบ' }).check();
  await page.getByRole('button', { name: 'ตรวจเอกสารและลงนาม' }).click();
  const dialog = page.getByRole('dialog', { name: 'ตรวจเอกสารก่อนลงนาม' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.pdf-loading')).toHaveCount(0);
  const canvas = dialog.locator('canvas');
  const bounds = await canvas.boundingBox();
  expect(bounds!.width / bounds!.height).toBeCloseTo(1.5, 1);
  await dialog
    .locator('.pdf-paper')
    .screenshot({ path: testInfo.outputPath('06-rotated-crop.png') });
});
