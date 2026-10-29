import { P12Session } from './p12.js';
let session: P12Session | undefined;
self.onmessage = async (
  event: MessageEvent<
    { type: 'read'; bytes: ArrayBuffer; password: string } | { type: 'wrap'; publicKey: string }
  >,
) => {
  try {
    if (event.data.type === 'read') {
      session = new P12Session(event.data.bytes, event.data.password);
      self.postMessage({ ok: true, value: session.metadata });
    } else {
      if (!session) throw new Error('กรุณาเลือกไฟล์ใหม่');
      self.postMessage({ ok: true, value: await session.wrap(event.data.publicKey) });
      session = undefined;
      self.close();
    }
  } catch (error) {
    session = undefined;
    self.postMessage({
      ok: false,
      message: error instanceof Error ? error.message : 'อ่านใบรับรองไม่ได้',
    });
    self.close();
  }
};
