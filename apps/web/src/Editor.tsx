import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  Type,
  CalendarDays,
  Stamp,
  PenLine,
  Undo2,
  Redo2,
  Trash2,
  Save,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  X,
  ShieldCheck,
  Download,
  LoaderCircle,
  Check,
  Fingerprint,
  Copy,
  Plus,
} from 'lucide-react';
import { startAuthentication } from '@simplewebauthn/browser';
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import type {
  DocumentRecord,
  Element,
  CertificateProfile,
  Session,
  SigningRequest,
} from '../../../packages/core/src/types';
import { api, date, download } from './api';
import { PdfCanvas } from './PdfCanvas';

interface Preview {
  id: string;
  hash: string;
  qr: boolean;
  verificationId?: string;
}
export function Editor({
  document: initial,
  certificates,
  session,
  onClose,
  onChanged,
  toast,
}: {
  document: DocumentRecord;
  certificates: CertificateProfile[];
  session: Session;
  onClose: () => void;
  onChanged: () => void;
  toast: (message: string, error?: boolean) => void;
}) {
  const [doc, setDoc] = useState(initial);
  const [elements, setElements] = useState<Element[]>(initial.elements);
  const [selected, setSelected] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [scale, setScale] = useState(1);
  const [history, setHistory] = useState<Element[][]>([]);
  const [redo, setRedo] = useState<Element[][]>([]);
  const [saveStatus, setSaveStatus] = useState('saved');
  const [qr, setQr] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [signing, setSigning] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [certificateId, setCertificateId] = useState(certificates.find((c) => c.canSign)?.id ?? '');
  const [passkey, setPasskey] = useState(session.passkeys > 0);
  const [draw, setDraw] = useState(false);
  const [revision, setRevision] = useState(initial.revisions.at(-1)!.id);
  const [pendingRequest, setPendingRequest] = useState<string | null>(null);
  const current = useRef(elements);
  current.current = elements;
  const version = useRef(initial.draftVersion);
  const saved = useRef(JSON.stringify(initial.elements));
  const saving = useRef<Promise<void> | null>(null);
  const mounted = useRef(true);
  const idempotency = useRef(crypto.randomUUID());
  const readOnly = doc.status === 'signed';
  const active = elements.find((e) => e.id === selected);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function save() {
    if (saving.current) return saving.current;
    const snapshot = JSON.stringify(current.current);
    if (readOnly || saved.current === snapshot) return;
    setSaveStatus('saving');
    const promise = api<DocumentRecord>(`/documents/${doc.id}/draft`, {
      method: 'POST',
      body: { draftVersion: version.current, elements: JSON.parse(snapshot) },
    })
      .then((result) => {
        version.current = result.draftVersion;
        saved.current = snapshot;
        if (mounted.current) {
          setDoc(result);
          setSaveStatus('saved');
        }
      })
      .catch((error) => {
        if (mounted.current) setSaveStatus('error');
        throw error;
      })
      .finally(() => {
        saving.current = null;
      });
    saving.current = promise;
    return promise;
  }
  useEffect(() => {
    if (readOnly || JSON.stringify(elements) === saved.current || saveStatus === 'error') return;
    const timeout = setTimeout(() => {
      void save().catch((error) => toast(error.message, true));
    }, 1000);
    return () => clearTimeout(timeout);
  }, [elements, saveStatus, readOnly]); // save uses refs to serialize draft writes
  function change(next: Element[]) {
    setHistory((h) => [...h.slice(-29), current.current]);
    setRedo([]);
    setElements(next);
    setSaveStatus('dirty');
    setPreview(null);
  }
  function patch(value: Partial<Element>) {
    if (active) change(elements.map((e) => (e.id === active.id ? { ...e, ...value } : e)));
  }
  function add(type: Element['type'], image?: string) {
    const el: Element = {
      id: crypto.randomUUID(),
      type,
      page,
      x: 0.12,
      y: 0.46,
      width: type === 'signature' ? 0.32 : 0.55,
      height: type === 'signature' ? 0.1 : 0.055,
      fontSize: type === 'stamp' ? 18 : 16,
      color: type === 'stamp' ? '#9d3f3f' : '#153f35',
      text:
        type === 'date'
          ? new Intl.DateTimeFormat('th-TH-u-nu-latn', {
              day: '2-digit',
              month: '2-digit',
              year: '2-digit',
              timeZone: 'Asia/Bangkok',
            }).format(new Date())
          : type === 'stamp'
            ? 'ตรวจสอบแล้ว'
            : type === 'text'
              ? 'พิมพ์ข้อความของคุณ'
              : '',
      image,
    };
    change([...elements, el]);
    setSelected(el.id);
  }
  async function showPreview() {
    setBusy(true);
    try {
      if (saving.current) await saving.current;
      await save();
      if (saved.current !== JSON.stringify(current.current)) await save();
      const result = await api<Preview>(`/documents/${doc.id}/preview`, {
        method: 'POST',
        body: { draftVersion: version.current, qr },
      });
      setPreview(result);
      setConfirmed(false);
      setPendingRequest(null);
      idempotency.current = crypto.randomUUID();
    } catch (error) {
      toast((error as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  async function refreshSigned() {
    const updated = await api<DocumentRecord>(`/documents/${doc.id}`);
    setDoc(updated);
    setRevision(updated.revisions.at(-1)!.id);
    setPreview(null);
    setSelected(null);
    onChanged();
    toast('ลงนามทดสอบและตรวจสอบลายเซ็นสำเร็จ');
  }
  async function sign() {
    if (!preview || !confirmed) return;
    setSigning(true);
    try {
      const request = await api<SigningRequest & { manifestToken: string }>('/signing/prepare', {
        method: 'POST',
        body: { previewId: preview.id, certificateId, idempotencyKey: idempotency.current },
      });
      setPendingRequest(request.id);
      let approval: { approvalToken: string };
      if (passkey) {
        const options = await api<PublicKeyCredentialRequestOptionsJSON>('/approval/options', {
          method: 'POST',
          body: { manifestToken: request.manifestToken },
        });
        const response = await startAuthentication({ optionsJSON: options });
        approval = await api('/approval/verify', {
          method: 'POST',
          body: { manifestToken: request.manifestToken, response },
        });
      } else
        approval = await api('/approval/demo', {
          method: 'POST',
          body: { manifestToken: request.manifestToken },
        });
      await api(`/signing/${request.id}/execute`, { method: 'POST', body: approval });
      await refreshSigned();
    } catch (error) {
      toast((error as Error).message, true);
    } finally {
      setSigning(false);
    }
  }
  async function reconcile() {
    if (!pendingRequest) return;
    setSigning(true);
    try {
      const result = await api<SigningRequest>(`/signing/${pendingRequest}`);
      if (result.state !== 'signed')
        await api(`/signing/${pendingRequest}/reconcile`, { method: 'POST', body: {} });
      await refreshSigned();
    } catch (error) {
      toast((error as Error).message, true);
    } finally {
      setSigning(false);
    }
  }
  return (
    <div className="editor-shell">
      <header className="editor-header">
        <button
          className="icon-button"
          aria-label="กลับไปเอกสาร"
          onClick={async () => {
            try {
              if (saving.current) await saving.current;
              await save();
              onChanged();
              onClose();
            } catch (error) {
              toast((error as Error).message, true);
            }
          }}
        >
          <ArrowLeft size={20} />
        </button>
        <div className="editor-title">
          <h2>{doc.title}</h2>
          <span>
            {readOnly
              ? 'ฉบับลงนาม · เปิดอ่านอย่างเดียว'
              : saveStatus === 'saving'
                ? 'กำลังบันทึก…'
                : saveStatus === 'error'
                  ? 'บันทึกไม่สำเร็จ'
                  : saveStatus === 'dirty'
                    ? 'กำลังรอบันทึก'
                    : 'บันทึกการเปลี่ยนแปลงแล้ว'}
            {saveStatus === 'saved' && !readOnly && <Check size={12} />}
          </span>
        </div>
        <div className="header-actions">
          {readOnly ? (
            <>
              <button
                className="button secondary"
                onClick={() =>
                  download(`/api/documents/${doc.id}/revisions/${revision}/file`, doc.title)
                }
              >
                <Download size={16} />
                ดาวน์โหลด PDF
              </button>
              <button
                className="button primary"
                onClick={async () => {
                  try {
                    const result = await api<{ crypto: string }>(`/documents/${doc.id}/verify`, {
                      method: 'POST',
                      body: { revisionId: revision },
                    });
                    toast(
                      result.crypto === 'valid'
                        ? 'ตรวจสอบลายเซ็นและ Hash ผ่าน · ใบรับรองทดสอบยังไม่เป็นที่เชื่อถือ'
                        : 'Hash ตรงกับต้นฉบับ · ฉบับนี้ยังไม่ได้ลงนาม',
                    );
                  } catch (error) {
                    toast((error as Error).message, true);
                  }
                }}
              >
                <ShieldCheck size={16} />
                ตรวจลายเซ็น
              </button>
            </>
          ) : (
            <>
              <button
                className="button secondary"
                onClick={() => void save().catch((e) => toast(e.message, true))}
              >
                <Save size={16} />
                บันทึกร่าง
              </button>
              <button
                className="button primary"
                disabled={busy || saveStatus === 'error'}
                onClick={() => void showPreview()}
              >
                {busy ? <LoaderCircle className="spin" size={16} /> : <PenLine size={16} />}
                ตรวจเอกสารและลงนาม
                <ArrowRight size={16} />
              </button>
            </>
          )}
        </div>
      </header>
      <div className="editor-body">
        <aside className="editor-tools">
          <div className="eyebrow">{readOnly ? 'DOCUMENT HISTORY' : 'จัดวางองค์ประกอบ'}</div>
          {readOnly ? (
            <>
              <div className="notice success">
                <ShieldCheck size={20} />
                <div>
                  ลงนามทดสอบแล้ว
                  <small>
                    ลายเซ็นเข้ารหัสผ่านการตรวจสอบ
                    <br />
                    ใบรับรอง Self-signed · ไม่ใช่ TDID
                  </small>
                </div>
              </div>
              {doc.revisions.map((r) => (
                <button
                  key={r.id}
                  className={`revision-button ${revision === r.id ? 'active' : ''}`}
                  onClick={() => setRevision(r.id)}
                >
                  <span>{r.kind === 'original' ? 'เอกสารต้นฉบับ' : 'ฉบับลงนามทดสอบ'}</span>
                  <small>{date(r.createdAt, true)}</small>
                </button>
              ))}
              <button
                className="button secondary full"
                onClick={async () => {
                  try {
                    await api(`/documents/${doc.id}/duplicate`, { method: 'POST', body: {} });
                    toast('สร้างสำเนาจากต้นฉบับแล้ว');
                    onChanged();
                    onClose();
                  } catch (error) {
                    toast((error as Error).message, true);
                  }
                }}
              >
                <Copy size={15} />
                สร้างสำเนาเพื่อแก้ไข
              </button>
            </>
          ) : (
            <>
              <button className="tool-button" onClick={() => add('text')}>
                <Type />
                ข้อความ<span>ไทย / อังกฤษ</span>
              </button>
              <button className="tool-button" onClick={() => add('date')}>
                <CalendarDays />
                วันที่<span>กำหนดวันที่ได้</span>
              </button>
              <button className="tool-button" onClick={() => add('stamp')}>
                <Stamp />
                ตราประทับ<span>ข้อความและกรอบ</span>
              </button>
              <button className="tool-button" onClick={() => setDraw(true)}>
                <PenLine />
                ภาพลายเซ็น<span>วาดด้วยเมาส์หรือปากกา</span>
              </button>
              <div className="tool-divider" />
              <div className="undo-row">
                <button
                  className="icon-button"
                  title="ย้อนกลับ"
                  disabled={!history.length}
                  onClick={() => {
                    setRedo((r) => [...r, elements]);
                    setElements(history.at(-1)!);
                    setHistory((h) => h.slice(0, -1));
                    setSaveStatus('dirty');
                  }}
                >
                  <Undo2 size={18} />
                </button>
                <button
                  className="icon-button"
                  title="ทำซ้ำ"
                  disabled={!redo.length}
                  onClick={() => {
                    setHistory((h) => [...h, elements]);
                    setElements(redo.at(-1)!);
                    setRedo((r) => r.slice(0, -1));
                    setSaveStatus('dirty');
                  }}
                >
                  <Redo2 size={18} />
                </button>
                <span>{elements.length} องค์ประกอบ</span>
              </div>
              <div className="editor-tip">
                ลากองค์ประกอบบนเอกสารเพื่อจัดตำแหน่ง ตรวจ PDF ฉบับสุดท้ายอีกครั้งก่อนลงนาม
              </div>
            </>
          )}
        </aside>
        <main className="editor-stage">
          <div className="page-controls">
            <button
              className="icon-button"
              disabled={page === 0}
              onClick={() => setPage((p) => p - 1)}
              aria-label="หน้าก่อน"
            >
              <ChevronLeft size={17} />
            </button>
            <span>
              หน้า <strong>{page + 1}</strong> / {doc.pages}
            </span>
            <button
              className="icon-button"
              disabled={page >= doc.pages - 1}
              onClick={() => setPage((p) => p + 1)}
              aria-label="หน้าถัดไป"
            >
              <ChevronRight size={17} />
            </button>
            <span className="page-size">PDF • พอดีความกว้าง</span>
          </div>
          <PdfCanvas
            url={`/api/documents/${doc.id}/revisions/${readOnly ? revision : doc.revisions[0].id}/file`}
            page={page}
            onScale={setScale}
          >
            {!readOnly &&
              elements
                .filter((e) => e.page === page)
                .map((el) => (
                  <div
                    key={el.id}
                    className={`pdf-element ${selected === el.id ? 'selected' : ''} ${el.type === 'stamp' ? 'stamp-element' : ''}`}
                    style={{
                      left: `${el.x * 100}%`,
                      top: `${el.y * 100}%`,
                      width: `${el.width * 100}%`,
                      height: `${el.height * 100}%`,
                      fontSize: el.fontSize * scale,
                      color: el.color,
                      borderColor: el.color,
                    }}
                    onPointerDown={(event) => {
                      if (busy) return;
                      event.preventDefault();
                      event.stopPropagation();
                      setSelected(el.id);
                      const target = event.currentTarget;
                      const parent = target.parentElement!;
                      const rect = parent.getBoundingClientRect();
                      const startX = event.clientX,
                        startY = event.clientY;
                      const before = current.current;
                      target.setPointerCapture(event.pointerId);
                      target.onpointermove = (move) => {
                        const x = Math.max(
                          0,
                          Math.min(1 - el.width, el.x + (move.clientX - startX) / rect.width),
                        );
                        const y = Math.max(
                          0,
                          Math.min(1 - el.height, el.y + (move.clientY - startY) / rect.height),
                        );
                        setElements((prev) =>
                          prev.map((e) => (e.id === el.id ? { ...e, x, y } : e)),
                        );
                        setSaveStatus('dirty');
                      };
                      target.onpointerup = () => {
                        target.onpointermove = null;
                        target.onpointerup = null;
                        setHistory((h) => [...h.slice(-29), before]);
                        setRedo([]);
                      };
                    }}
                  >
                    {el.type === 'signature' ? (
                      <img src={el.image} alt="ภาพลายเซ็น" draggable={false} />
                    ) : (
                      el.text
                    )}
                    {selected === el.id && <span className="element-handle" />}
                  </div>
                ))}
          </PdfCanvas>
        </main>
        <aside className="editor-properties">
          <div className="eyebrow">{active && !readOnly ? 'คุณสมบัติ' : 'ข้อมูลเอกสาร'}</div>
          {active && !readOnly ? (
            <>
              {active.type !== 'signature' && (
                <label className="field">
                  ข้อความ
                  <textarea
                    value={active.text}
                    onChange={(e) => patch({ text: e.target.value })}
                    rows={3}
                  />
                </label>
              )}
              <div className="two-fields">
                <label className="field">
                  ขนาดตัวอักษร
                  <input
                    type="number"
                    min={6}
                    max={72}
                    value={active.fontSize}
                    onChange={(e) =>
                      patch({ fontSize: Math.max(6, Math.min(72, Number(e.target.value) || 6)) })
                    }
                  />
                </label>
                <label className="field">
                  สี
                  <input
                    type="color"
                    value={active.color}
                    onChange={(e) => patch({ color: e.target.value })}
                  />
                </label>
              </div>
              <label className="field">
                ความกว้าง
                <input
                  type="range"
                  min="10"
                  max={Math.floor((1 - active.x) * 100)}
                  value={active.width * 100}
                  onChange={(e) => patch({ width: Number(e.target.value) / 100 })}
                />
              </label>
              <div className="two-fields">
                <label className="field">
                  ตำแหน่ง X (%)
                  <input
                    type="number"
                    min={0}
                    max={(1 - active.width) * 100}
                    value={Math.round(active.x * 100)}
                    onChange={(e) =>
                      patch({
                        x: Math.max(0, Math.min(1 - active.width, Number(e.target.value) / 100)),
                      })
                    }
                  />
                </label>
                <label className="field">
                  ตำแหน่ง Y (%)
                  <input
                    type="number"
                    min={0}
                    max={(1 - active.height) * 100}
                    value={Math.round(active.y * 100)}
                    onChange={(e) =>
                      patch({
                        y: Math.max(0, Math.min(1 - active.height, Number(e.target.value) / 100)),
                      })
                    }
                  />
                </label>
              </div>
              <button
                className="button danger-light full"
                onClick={() => {
                  change(elements.filter((e) => e.id !== active.id));
                  setSelected(null);
                }}
              >
                <Trash2 size={15} />
                ลบองค์ประกอบ
              </button>
            </>
          ) : (
            <>
              <dl className="detail-list">
                <div>
                  <dt>จำนวนหน้า</dt>
                  <dd>{doc.pages} หน้า</dd>
                </div>
                <div>
                  <dt>สร้างเมื่อ</dt>
                  <dd>{date(doc.createdAt)}</dd>
                </div>
                <div>
                  <dt>ฉบับที่จัดเก็บ</dt>
                  <dd>{doc.revisions.length} ฉบับ</dd>
                </div>
              </dl>
              <div className="hash-card">
                <small>SHA-256 · ต้นฉบับ</small>
                <code>{doc.revisions[0].sha256}</code>
              </div>
            </>
          )}
          {!readOnly && (
            <>
              <div className="tool-divider" />
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={qr}
                  onChange={(e) => {
                    setQr(e.target.checked);
                    setPreview(null);
                  }}
                />
                <span>เพิ่ม QR สำหรับตรวจสอบ</span>
              </label>
              <p className="muted small">
                QR จะแสดงหลักฐานของฉบับที่ระบบเก็บไว้ และไม่เปิดเผยไฟล์ต่อสาธารณะ
              </p>
            </>
          )}
          <div className="editor-tip bottom-tip">
            วันที่บนตราประทับแยกจากเวลาลงนามจริง
            ภาพลายเซ็นจะได้รับการคุ้มครองเมื่อเอกสารถูกลงนามดิจิทัล
          </div>
        </aside>
      </div>
      {preview && (
        <div className="modal-backdrop">
          <section
            className="preview-modal"
            role="dialog"
            aria-modal="true"
            aria-label="ตรวจเอกสารก่อนลงนาม"
          >
            <header>
              <div>
                <div className="eyebrow">FINAL REVIEW</div>
                <h2>ตรวจเอกสารก่อนลงนาม</h2>
              </div>
              <button
                className="icon-button"
                disabled={signing}
                onClick={() => setPreview(null)}
                aria-label="ปิด"
              >
                <X />
              </button>
            </header>
            <div className="preview-body">
              <div className="preview-pdf">
                <div className="page-controls">
                  <button
                    className="icon-button"
                    disabled={page === 0}
                    onClick={() => setPage((p) => p - 1)}
                  >
                    <ChevronLeft size={16} />
                  </button>
                  หน้า {page + 1} / {doc.pages}
                  <button
                    className="icon-button"
                    disabled={page === doc.pages - 1}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    <ChevronRight size={16} />
                  </button>
                </div>
                <PdfCanvas url={`/api/previews/${preview.id}/file`} page={page} />
              </div>
              <aside>
                <ShieldCheck size={30} className="green" />
                <h3>ยืนยันเอกสารฉบับนี้</h3>
                <p className="muted small">
                  นี่คือ PDF ที่จัดวางองค์ประกอบแล้ว การเปลี่ยนเนื้อหาจะต้องตรวจและอนุมัติใหม่
                </p>
                <label className="field">
                  ใบรับรอง
                  <select value={certificateId} onChange={(e) => setCertificateId(e.target.value)}>
                    {certificates
                      .filter((c) => c.canSign)
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.label}
                        </option>
                      ))}
                  </select>
                </label>
                <div className="notice warning">
                  ใบรับรองทดสอบ Self-signed ไม่ใช่ TDID และไม่มี Trusted Timestamp
                </div>
                <div className="hash-card">
                  <small>SHA-256 · PDF ก่อนลงนาม</small>
                  <code>{preview.hash}</code>
                </div>
                {session.passkeys > 0 && (
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={passkey}
                      onChange={(e) => setPasskey(e.target.checked)}
                    />
                    <Fingerprint size={16} />
                    <span>อนุมัติด้วย Passkey</span>
                  </label>
                )}
                <label className="check-row consent">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  <span>ตรวจเอกสารฉบับนี้แล้ว และยืนยันการลงนามทดสอบ</span>
                </label>
                <button
                  className="button primary full"
                  disabled={!confirmed || signing || !certificateId}
                  onClick={() => void sign()}
                >
                  {signing ? <LoaderCircle className="spin" size={17} /> : <PenLine size={17} />}
                  ลงนามทดสอบ
                </button>
                {pendingRequest && !signing && (
                  <button className="button secondary full mt" onClick={() => void reconcile()}>
                    ตรวจสอบผลรายการเดิม
                  </button>
                )}
                <p className="muted tiny">ระบบจะตรวจลายเซ็นและเนื้อหาก่อนจัดเก็บฉบับลงนาม</p>
              </aside>
            </div>
          </section>
        </div>
      )}
      {draw && (
        <SignatureDialog
          onClose={() => setDraw(false)}
          onSave={(image) => {
            add('signature', image);
            setDraw(false);
          }}
        />
      )}
    </div>
  );
}

function SignatureDialog({
  onClose,
  onSave,
}: {
  onClose: () => void;
  onSave: (image: string) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [hasInk, setHasInk] = useState(false);
  return (
    <div className="modal-backdrop">
      <section
        className="modal signature-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="วาดภาพลายเซ็น"
      >
        <header>
          <h2>วาดภาพลายเซ็น</h2>
          <button className="icon-button" onClick={onClose} aria-label="ปิด">
            <X />
          </button>
        </header>
        <p className="muted">ใช้เมาส์ นิ้ว หรือปากกาวาดในพื้นที่ด้านล่าง</p>
        <canvas
          ref={canvas}
          width={840}
          height={320}
          className="signature-canvas"
          onPointerDown={(event) => {
            const c = canvas.current!,
              ctx = c.getContext('2d')!,
              rect = c.getBoundingClientRect();
            const pos = (e: { clientX: number; clientY: number }) => ({
              x: ((e.clientX - rect.left) * c.width) / rect.width,
              y: ((e.clientY - rect.top) * c.height) / rect.height,
            });
            const p = pos(event);
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineWidth = 4;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.strokeStyle = '#163f36';
            c.setPointerCapture(event.pointerId);
            c.onpointermove = (move) => {
              const next = pos(move);
              ctx.lineTo(next.x, next.y);
              ctx.stroke();
              setHasInk(true);
            };
            c.onpointerup = () => {
              c.onpointermove = null;
            };
          }}
        />
        <div className="modal-footer">
          <button
            className="button secondary"
            onClick={() => {
              canvas.current!.getContext('2d')!.clearRect(0, 0, 840, 320);
              setHasInk(false);
            }}
          >
            ล้างและวาดใหม่
          </button>
          <button
            className="button primary"
            disabled={!hasInk}
            onClick={() => onSave(canvas.current!.toDataURL('image/png'))}
          >
            <Plus size={16} />
            เพิ่มลงในเอกสาร
          </button>
        </div>
        <p className="tiny muted">
          ภาพนี้เป็นองค์ประกอบบนเอกสาร การลงนามดิจิทัลจะเกิดขึ้นในขั้นตอนยืนยัน
        </p>
      </section>
    </div>
  );
}
