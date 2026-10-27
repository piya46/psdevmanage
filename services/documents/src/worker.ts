import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { AppError } from '../../../packages/core/src/errors.js';

let active = 0;
export async function pdfTask<T>(input: Record<string, unknown>): Promise<T> {
  if (active >= 2) throw new AppError(429, 'PDF_BUSY', 'ระบบกำลังประมวลผลเอกสาร กรุณาลองอีกครั้ง');
  active++;
  try {
    return await new Promise<T>((resolve, reject) => {
      const built =
        existsSync('dist/services/documents/pdf-worker.js') && !process.execArgv.includes('tsx');
      const args = built
        ? ['--max-old-space-size=384', 'dist/services/documents/pdf-worker.js']
        : ['--max-old-space-size=384', '--import', 'tsx', 'services/documents/src/pdf-worker.ts'];
      const child = spawn(process.execPath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH, NODE_NO_WARNINGS: '1' },
      });
      const chunks: Buffer[] = [];
      let bytes = 0;
      let error = '';
      let timeout = false;
      const timer = setTimeout(() => {
        timeout = true;
        child.kill('SIGKILL');
      }, 25000);
      child.stdout.on('data', (data: Buffer) => {
        bytes += data.length;
        if (bytes > 80 * 1024 * 1024) child.kill('SIGKILL');
        else chunks.push(data);
      });
      child.stderr.on('data', (data: Buffer) => {
        if (error.length < 8000) error += data.toString();
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0)
          return reject(
            new AppError(
              422,
              timeout ? 'PDF_TIMEOUT' : 'PDF_REJECTED',
              timeout
                ? 'เอกสารใช้เวลาประมวลผลเกินกำหนด'
                : 'ไม่รองรับ PDF นี้: ไฟล์อาจเสียหาย เข้ารหัส มีลายเซ็นเดิม หรือมีเนื้อหาที่ไม่ปลอดภัย',
            ),
          );
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString()) as T);
        } catch {
          reject(new Error('PDF worker returned an invalid response'));
        }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(input));
    });
  } finally {
    active--;
  }
}
