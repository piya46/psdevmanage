import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Upload, CheckCircle2 } from 'lucide-react';
import { api } from './api.js';
import type { P12Metadata } from './p12.js';

interface ImportStatus {
  id: string;
  state: string;
  publicKey?: string;
}
function workerCall<T>(
  worker: Worker,
  message: unknown,
  transfers: Transferable[] = [],
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error('อ่านไฟล์นานเกินไป กรุณาลองใหม่'));
    }, 60000);
    worker.onmessage = (event) => {
      clearTimeout(timer);
      if (event.data.ok) resolve(event.data.value as T);
      else reject(new Error(event.data.message));
    };
    worker.onerror = () => {
      clearTimeout(timer);
      reject(new Error('ประมวลผลใบรับรองไม่ได้'));
    };
    worker.postMessage(message, transfers);
  });
}
export function ImportCertificate({ onDone }: { onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const password = useRef<HTMLInputElement>(null);
  const worker = useRef<Worker | null>(null);
  const mounted = useRef(true);
  const importId = useRef<string | null>(null);
  const [label, setLabel] = useState('TDID · ใบรับรองของฉัน');
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [canReconcile, setCanReconcile] = useState(false);
  const [pending, setPending] = useState<{ id: string; label: string }[]>([]);
  useEffect(() => {
    mounted.current = true;
    void api<{ imports: { id: string; label: string }[] }>('/certificates/imports')
      .then((result) => {
        if (mounted.current) setPending(result.imports);
      })
      .catch(() => {});
    return () => {
      mounted.current = false;
      worker.current?.terminate();
    };
  }, []);
  async function poll(id: string, needsKey: boolean) {
    for (let attempt = 0; attempt < 90; attempt++) {
      if (!mounted.current) throw new Error('ปิดรายการนำเข้าแล้ว');
      const state = await api<ImportStatus>(`/certificates/imports/${id}`);
      if (state.state === 'failed')
        throw new Error('HSM นำเข้ากุญแจไม่สำเร็จ กรุณาตรวจไฟล์แล้วเริ่มใหม่');
      if (needsKey ? !!state.publicKey : state.state === 'ready') return state;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error('HSM ยังประมวลผลอยู่ กดตรวจสอบรายการเดิมอีกครั้ง');
  }
  async function submit() {
    if (!file || !accepted || !label.trim()) return;
    setBusy(true);
    setError('');
    setCanReconcile(false);
    try {
      setMessage('กำลังอ่านใบรับรองในเบราว์เซอร์…');
      const instance = new Worker(new URL('./p12-worker.ts', import.meta.url), { type: 'module' });
      worker.current = instance;
      const bytes = await file.arrayBuffer();
      const read = workerCall<P12Metadata>(
        instance,
        { type: 'read', bytes, password: password.current?.value ?? '' },
        [bytes],
      );
      if (password.current) password.current.value = '';
      const metadata = await read;
      setMessage('กำลังตรวจใบรับรองและเตรียมพื้นที่เก็บกุญแจ…');
      const id = crypto.randomUUID();
      importId.current = id;
      await api('/certificates/imports', {
        method: 'POST',
        body: {
          pem: metadata.pem,
          label,
          idempotencyKey: id,
          policyAccepted: accepted,
        },
      });
      const ready = await poll(id, true);
      setMessage('กำลังเข้ารหัสและนำกุญแจเข้า HSM…');
      const wrappedKey = await workerCall<string>(instance, {
        type: 'wrap',
        publicKey: ready.publicKey,
      });
      setCanReconcile(true);
      await api(`/certificates/imports/${id}`, { method: 'POST', body: { wrappedKey } });
      setMessage('กำลังตรวจว่ากุญแจตรงกับใบรับรอง…');
      await poll(id, false);
      onDone();
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      worker.current?.terminate();
      worker.current = null;
      if (password.current) password.current.value = '';
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <div>
      {pending.map((item) => (
        <button
          key={item.id}
          className="button secondary full mt"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              await poll(item.id, false);
              onDone();
            } catch (e) {
              if (mounted.current) setError((e as Error).message);
            } finally {
              if (mounted.current) setBusy(false);
            }
          }}
        >
          ตรวจสอบรายการค้าง: {item.label}
        </button>
      ))}
      <p className="muted small">
        เลือกไฟล์ .p12 หรือ .pfx ของคุณ รหัสผ่านใช้เปิดไฟล์ในเบราว์เซอร์
        กุญแจจะถูกเข้ารหัสก่อนนำเข้า Cloud HSM
      </p>
      <label className="field">
        ชื่อใบรับรอง
        <input
          value={label}
          disabled={busy}
          maxLength={100}
          onChange={(e) => setLabel(e.target.value)}
        />
      </label>
      <label className="field">
        ไฟล์ใบรับรอง
        <input
          type="file"
          accept=".p12,.pfx"
          disabled={busy}
          onChange={(e) => {
            const value = e.target.files?.[0] ?? null;
            if (value && (!/\.(p12|pfx)$/i.test(value.name) || value.size > 2 * 1024 * 1024)) {
              setError('เลือกไฟล์ P12/PFX ขนาดไม่เกิน 2 MB');
              setFile(null);
              return;
            }
            setFile(value);
            setError('');
          }}
        />
      </label>
      <label className="field">
        รหัสผ่านไฟล์
        <input ref={password} type="password" autoComplete="off" disabled={busy} />
      </label>
      <label className="check-row consent">
        <input
          type="checkbox"
          checked={accepted}
          disabled={busy}
          onChange={(e) => setAccepted(e.target.checked)}
        />
        <span>
          ฉันเป็นเจ้าของกุญแจหรือได้รับมอบอำนาจ และใบรับรองนี้อนุญาตให้ใช้ลงนามผ่านระบบนี้
        </span>
      </label>
      <p className="tiny muted">
        รองรับใบรับรอง TDID CA G3 แบบ RSA ระบบตรวจสถานะเพิกถอนก่อนลงนาม และให้ยืนยันแต่ละรายการด้วย
        Passkey
      </p>
      {message && (
        <p role="status" className="muted small">
          {message}
        </p>
      )}
      {error && (
        <div role="alert" className="notice warning">
          {error}
        </div>
      )}
      <button
        className="button primary full"
        disabled={busy || !file || !accepted || !label.trim()}
        onClick={() => void submit()}
      >
        {busy ? <LoaderCircle size={16} className="spin" /> : <Upload size={16} />}
        นำเข้าใบรับรองสำหรับลงนาม
      </button>
      {canReconcile && !busy && (
        <button
          className="button secondary full mt"
          onClick={async () => {
            if (!importId.current) return;
            setBusy(true);
            setError('');
            try {
              await poll(importId.current, false);
              onDone();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <CheckCircle2 size={16} />
          ตรวจสอบรายการนำเข้าเดิม
        </button>
      )}
    </div>
  );
}
