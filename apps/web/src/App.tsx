import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from 'react';
import {
  FolderOpen,
  ShieldCheck,
  Fingerprint,
  History,
  Trash2,
  Search,
  Upload,
  Plus,
  ArrowUpRight,
  ArrowRight,
  FileText,
  MoreHorizontal,
  Download,
  Check,
  X,
  LoaderCircle,
  LogOut,
  ChevronRight,
  LayoutGrid,
  List,
  LockKeyhole,
  KeyRound,
  RefreshCw,
  ExternalLink,
  FileCheck2,
  HardDrive,
  CircleHelp,
  ShieldAlert,
  Copy,
  RotateCcw,
  CheckCircle2,
  AlertTriangle,
  FileSearch,
  Link,
  Clock3,
  Menu,
} from 'lucide-react';
import {
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
} from '@simplewebauthn/browser';
import type {
  DocumentRecord,
  CertificateProfile,
  Session,
  AuditRecord,
} from '../../../packages/core/src/types';
import { api, setCsrf, maxUploadBytes, formatBytes, date, download } from './api';
import { ImportCertificate } from './ImportCertificate';
const Editor = lazy(() => import('./Editor').then((module) => ({ default: module.Editor })));

type View = 'documents' | 'certificates' | 'verify' | 'security' | 'audit' | 'trash';
type Toast = (message: string, error?: boolean) => void;
const nav: [View, string, typeof FolderOpen][] = [
  ['documents', 'เอกสารทั้งหมด', FolderOpen],
  ['certificates', 'ใบรับรองของฉัน', ShieldCheck],
  ['verify', 'ตรวจสอบเอกสาร', FileSearch],
  ['security', 'ศูนย์ความปลอดภัย', Fingerprint],
  ['audit', 'บันทึกกิจกรรม', History],
  ['trash', 'ถังขยะ', Trash2],
];
const eventNames: Record<string, string> = {
  'auth.login': 'เข้าสู่ระบบ',
  'auth.logout': 'ออกจากระบบ',
  'auth.passkey_registered': 'ลงทะเบียน Passkey',
  'document.uploaded': 'เพิ่มเอกสาร',
  'document.draft_saved': 'บันทึกร่างเอกสาร',
  'document.downloaded': 'เปิดหรือดาวน์โหลดเอกสาร',
  'document.signed': 'จัดเก็บฉบับลงนาม',
  'document.verified': 'ตรวจสอบลายเซ็น',
  'document.soft_deleted': 'ย้ายเอกสารลงถังขยะ',
  'document.restored': 'กู้คืนเอกสาร',
  'signing.prepared': 'เตรียมเอกสารเพื่อลงนาม',
  'signing.approved': 'อนุมัติการลงนาม',
  'signing.started': 'เริ่มลงนาม',
  'signing.completed': 'ลงนามสำเร็จ',
  'signing.interrupted': 'การลงนามต้องตรวจสอบ',
  'security.signing_locked': 'ระงับการลงนาม',
  'security.demo_signing_unlocked': 'เปิดการลงนามทดสอบ',
  'certificate.public_imported': 'เพิ่มใบรับรองสาธารณะ',
};

function Brand({ light = false }: { light?: boolean }) {
  return (
    <div className={`brand ${light ? 'light' : ''}`}>
      <span className="brand-mark">
        <span />
        <span />
        <span />
      </span>
      <strong>
        PSTON<span>DOCUMENT WORKSPACE</span>
      </strong>
    </div>
  );
}
function Empty({
  icon: Icon = FolderOpen,
  title,
  description,
  children,
}: {
  icon?: typeof FolderOpen;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <Icon size={30} />
      </div>
      <h3>{title}</h3>
      <p>{description}</p>
      {children}
    </div>
  );
}
function Status({ signed, testOnly }: { signed: boolean; testOnly: boolean }) {
  return (
    <span className={`status ${signed ? 'signed' : 'draft'}`}>
      <span />
      {signed ? (testOnly ? 'ลงนามทดสอบแล้ว' : 'ลงนามแล้ว') : 'แบบร่าง'}
    </span>
  );
}
export function App() {
  return window.location.pathname.startsWith('/verify/') ? (
    <PublicVerify id={window.location.pathname.split('/')[2] ?? ''} />
  ) : (
    <Workspace />
  );
}

function Workspace() {
  const [session, setSession] = useState<Session | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [loginMode, setLoginMode] = useState('demo');
  const [view, setView] = useState<View>('documents');
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [certificates, setCertificates] = useState<CertificateProfile[]>([]);
  const [signingProvider, setSigningProvider] = useState({
    configured: false,
    message: 'กำลังตรวจสอบระบบลงนาม',
  });
  const [stats, setStats] = useState({ total: 0, signed: 0, draft: 0, bytes: 0 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [grid, setGrid] = useState(false);
  const [editing, setEditing] = useState<DocumentRecord | null>(null);
  const [uploading, setUploading] = useState(false);
  const [drag, setDrag] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [help, setHelp] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toast: Toast = (text, isError = false) => {
    setMessage({ text, error: isError });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setMessage(null), 6500);
  };
  async function refreshSession() {
    const data = await api<Session & { user: Session['user'] | null }>('/session');
    setLoginMode(data.mode);
    if (data.user) {
      setSession(data);
      setCsrf(data.csrf);
    } else setSession(null);
  }
  useEffect(() => {
    void refreshSession()
      .catch((e) => setError(e.message))
      .finally(() => setInitializing(false));
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);
  async function load() {
    setLoading(true);
    setError('');
    try {
      const [result, certs] = await Promise.all([
        api<{ documents: DocumentRecord[]; stats: typeof stats }>(
          `/documents?scope=${view === 'trash' ? 'trash' : 'active'}`,
        ),
        api<{ certificates: CertificateProfile[]; provider: typeof signingProvider }>(
          '/certificates',
        ),
      ]);
      setDocuments(result.documents);
      setStats(result.stats);
      setCertificates(certs.certificates);
      setSigningProvider(certs.provider);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    if (session) void load();
  }, [session?.user.id, view]);
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        search.current?.focus();
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);
  async function upload(file?: File) {
    if (!file) return;
    if (file.size > maxUploadBytes) {
      toast(`เลือกไฟล์ PDF ขนาดไม่เกิน ${maxUploadBytes / 1024 / 1024} MB`, true);
      return;
    }
    setUploading(true);
    try {
      const form = new FormData();
      form.set('file', file);
      const doc = await api<DocumentRecord>('/documents', { method: 'POST', body: form });
      toast('อัปโหลดและตรวจสอบเอกสารแล้ว');
      await load();
      setEditing(doc);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }
  async function sample() {
    setUploading(true);
    try {
      const doc = await api<DocumentRecord>('/documents/sample', { method: 'POST', body: {} });
      await load();
      setEditing(doc);
      toast('สร้างเอกสารตัวอย่างแล้ว');
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setUploading(false);
    }
  }
  const visible = documents.filter(
    (d) =>
      (filter === 'all' || d.status === filter) &&
      d.title.toLowerCase().includes(query.toLowerCase()),
  );
  if (initializing)
    return (
      <div className="boot-screen">
        <Brand />
        <LoaderCircle className="spin" />
        <p>กำลังเปิดพื้นที่เอกสาร</p>
      </div>
    );
  if (!session)
    return (
      <>
        <Login
          mode={loginMode}
          error={error}
          onDemo={async () => {
            try {
              const result = await api<Session>('/auth/demo', { method: 'POST', body: {} });
              setCsrf(result.csrf);
              setSession(result);
              setError('');
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        />
      </>
    );
  return (
    <>
      <div className="app-layout">
        <aside className={`sidebar ${mobileNav ? 'mobile-open' : ''}`}>
          <Brand light />
          <div className="workspace-label">
            พื้นที่ทำงานส่วนตัว<span>PERSONAL</span>
          </div>
          <nav aria-label="เมนูหลัก">
            {nav.map(([id, label, Icon], index) => (
              <button
                key={id}
                className={`${view === id ? 'active' : ''} ${index === 3 ? 'nav-divider' : ''}`}
                onClick={() => {
                  setView(id);
                  setQuery('');
                  setFilter('all');
                  setMobileNav(false);
                }}
              >
                <Icon size={19} />
                <span>{label}</span>
                {id === 'documents' && <b>{stats.total}</b>}
              </button>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <div className="private-note">
              <LockKeyhole size={17} />
              <div>
                พื้นที่ของคุณเท่านั้น<small>เอกสารไม่ถูกเปิดเป็นสาธารณะ</small>
              </div>
            </div>
            <button className="sidebar-help" onClick={() => setHelp(true)}>
              <CircleHelp size={17} />
              <span>
                {session.mode === 'demo' ? 'เกี่ยวกับพื้นที่ทดลอง' : 'เกี่ยวกับพื้นที่เอกสาร'}
              </span>
              <ArrowUpRight size={14} />
            </button>
            <div className="user-profile">
              <span className="avatar">PS</span>
              <div>
                <strong>{session.user.name}</strong>
                <small>{session.user.mode === 'demo' ? 'บัญชีทดลอง' : session.user.email}</small>
              </div>
              <button
                aria-label="ออกจากระบบ"
                title="ออกจากระบบ"
                onClick={async () => {
                  try {
                    await api('/auth/logout', { method: 'POST', body: {} });
                    setSession(null);
                    setCsrf('');
                  } catch (e) {
                    toast((e as Error).message, true);
                  }
                }}
              >
                <LogOut size={17} />
              </button>
            </div>
          </div>
        </aside>
        <div className="main-shell">
          <header className="topbar">
            <button
              className="icon-button mobile-menu"
              aria-label="เปิดเมนู"
              onClick={() => setMobileNav((v) => !v)}
            >
              <Menu />
            </button>
            <div className="breadcrumb">
              พื้นที่ส่วนตัว
              <ChevronRight size={13} />
              <strong>{nav.find((n) => n[0] === view)?.[1]}</strong>
            </div>
            <div className="topbar-right">
              <span className="today">
                {new Intl.DateTimeFormat('th-TH', {
                  day: 'numeric',
                  month: 'long',
                  year: 'numeric',
                  timeZone: 'Asia/Bangkok',
                }).format(new Date())}
              </span>
              <span className="mode-chip">
                <span />
                {session.mode === 'demo' ? 'พื้นที่ทดลอง' : 'พื้นที่ส่วนตัว'}
              </span>
            </div>
          </header>
          <main
            className="workspace-main"
            onDragOver={(e) => {
              if (view === 'documents') {
                e.preventDefault();
                setDrag(true);
              }
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrag(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              if (view === 'documents') void upload(e.dataTransfer.files[0]);
            }}
          >
            {error && (
              <div className="notice warning">
                <AlertTriangle size={18} />
                <span>{error}</span>
                <button className="text-button" onClick={() => void load()}>
                  ลองอีกครั้ง
                </button>
              </div>
            )}
            {(view === 'documents' || view === 'trash') && (
              <>
                <div className="page-heading">
                  <div>
                    <div className="eyebrow">YOUR DOCUMENT WORKSPACE</div>
                    <h1>
                      {view === 'trash' ? 'ถังขยะ' : 'เอกสารของคุณ'}
                      <span className="heading-dot">.</span>
                    </h1>
                    <p>
                      {view === 'trash'
                        ? 'กู้คืนเอกสารที่ย้ายมาพักไว้ โดยเก็บประวัติฉบับเดิม'
                        : 'จัดเตรียม ลงนาม และเก็บทุกฉบับไว้ในพื้นที่เดียว'}
                    </p>
                  </div>
                  {view === 'documents' && (
                    <button
                      className="button primary upload-main"
                      disabled={uploading}
                      onClick={() => fileInput.current?.click()}
                    >
                      {uploading ? <LoaderCircle size={17} className="spin" /> : <Plus size={18} />}
                      อัปโหลดเอกสาร
                    </button>
                  )}
                </div>
                {view === 'documents' && (
                  <>
                    <div className="workspace-banner">
                      <div className="banner-icon">
                        <ShieldCheck size={29} />
                      </div>
                      <div>
                        <h3>ทุกฉบับชัดเจน ทุกการลงนามมีหลักฐาน</h3>
                        <p>ต้นฉบับและฉบับลงนามจัดเก็บแยกกัน พร้อม SHA-256 และประวัติการใช้งาน</p>
                      </div>
                      <button onClick={() => setView('security')}>
                        ดูความปลอดภัย
                        <ArrowUpRight size={16} />
                      </button>
                      <div className="banner-decoration" />
                    </div>
                    <div className="stats-grid">
                      <Stat
                        label="เอกสารทั้งหมด"
                        value={stats.total.toString()}
                        suffix="เอกสาร"
                        icon={FolderOpen}
                        note="ในพื้นที่ส่วนตัว"
                      />
                      <Stat
                        label={session.mode === 'demo' ? 'ลงนามทดสอบแล้ว' : 'ลงนามแล้ว'}
                        value={stats.signed.toString()}
                        suffix="เอกสาร"
                        icon={FileCheck2}
                        note="ตรวจลายเซ็นก่อนจัดเก็บ"
                      />
                      <Stat
                        label="แบบร่าง"
                        value={stats.draft.toString()}
                        suffix="เอกสาร"
                        icon={PenIcon}
                        note="พร้อมจัดเตรียมและตรวจทาน"
                      />
                      <Stat
                        label="พื้นที่จัดเก็บ"
                        value={formatBytes(stats.bytes).split(' ')[0]}
                        suffix={formatBytes(stats.bytes).split(' ')[1]}
                        icon={HardDrive}
                        note="รวมต้นฉบับและฉบับลงนาม"
                      />
                    </div>
                  </>
                )}
                <section className="documents-panel">
                  <div className="panel-top">
                    <h2>
                      {view === 'trash' ? 'เอกสารในถังขยะ' : 'รายการเอกสาร'}
                      <span>{documents.length}</span>
                    </h2>
                    <div className="view-switch">
                      <button
                        className={!grid ? 'active' : ''}
                        aria-label="มุมมองรายการ"
                        onClick={() => setGrid(false)}
                      >
                        <List size={17} />
                      </button>
                      <button
                        className={grid ? 'active' : ''}
                        aria-label="มุมมองการ์ด"
                        onClick={() => setGrid(true)}
                      >
                        <LayoutGrid size={17} />
                      </button>
                    </div>
                  </div>
                  <div className="document-controls">
                    <div className="filter-tabs">
                      <button
                        className={filter === 'all' ? 'active' : ''}
                        onClick={() => setFilter('all')}
                      >
                        ทั้งหมด
                      </button>
                      <button
                        className={filter === 'draft' ? 'active' : ''}
                        onClick={() => setFilter('draft')}
                      >
                        แบบร่าง
                      </button>
                      <button
                        className={filter === 'signed' ? 'active' : ''}
                        onClick={() => setFilter('signed')}
                      >
                        ลงนามแล้ว
                      </button>
                    </div>
                    <div className="search-box">
                      <Search size={16} />
                      <input
                        ref={search}
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="ค้นหาชื่อเอกสาร…"
                        aria-label="ค้นหาชื่อเอกสาร"
                      />
                      <kbd>⌘ K</kbd>
                    </div>
                  </div>
                  {loading ? (
                    <div className="loading-state">
                      <LoaderCircle className="spin" />
                      กำลังโหลดเอกสาร
                    </div>
                  ) : visible.length === 0 ? (
                    <Empty
                      title={
                        query
                          ? 'ไม่พบเอกสารที่ค้นหา'
                          : view === 'trash'
                            ? 'ถังขยะว่างอยู่'
                            : 'เริ่มต้นเอกสารฉบับแรก'
                      }
                      description={
                        query
                          ? 'ลองเปลี่ยนคำค้นหรือเลือกสถานะทั้งหมด'
                          : view === 'trash'
                            ? 'เอกสารที่ลบจะปรากฏที่นี่เพื่อให้กู้คืนได้'
                            : 'อัปโหลด PDF ของคุณ หรือเปิดเอกสารตัวอย่างเพื่อทดลองจัดวางและลงนาม'
                      }
                    >
                      {view === 'documents' && !query && (
                        <div className="empty-actions">
                          <button
                            className="button primary"
                            onClick={() => fileInput.current?.click()}
                            disabled={uploading}
                          >
                            <Upload size={16} />
                            เลือกไฟล์ PDF
                          </button>
                          {session.mode === 'demo' && (
                            <button
                              className="button secondary"
                              onClick={() => void sample()}
                              disabled={uploading}
                            >
                              {uploading ? (
                                <LoaderCircle className="spin" size={16} />
                              ) : (
                                <FileText size={16} />
                              )}
                              ใช้เอกสารตัวอย่าง
                            </button>
                          )}
                        </div>
                      )}
                    </Empty>
                  ) : grid ? (
                    <div className="document-grid">
                      {visible.map((doc) => (
                        <article key={doc.id} className="document-card">
                          <button
                            className="card-preview"
                            onClick={() => (view === 'trash' ? undefined : setEditing(doc))}
                            aria-label={`เปิด ${doc.title}`}
                          >
                            <div className="mini-page">
                              <span>PSTON</span>
                              <b />
                              <i />
                              <i />
                              <i />
                              <i />
                              <div>
                                <ShieldCheck size={26} />
                              </div>
                            </div>
                          </button>
                          <div className="document-card-body">
                            <Status
                              signed={doc.status === 'signed'}
                              testOnly={session.mode === 'demo'}
                            />
                            <h3>{doc.title}</h3>
                            <p>
                              {doc.pages} หน้า · {formatBytes(doc.bytes)}
                            </p>
                            <div>
                              <span>{date(doc.updatedAt)}</span>
                              <DocumentMenu
                                doc={doc}
                                trash={view === 'trash'}
                                onEdit={() => setEditing(doc)}
                                onChanged={() => void load()}
                                toast={toast}
                              />
                            </div>
                          </div>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <div className="table-scroll">
                      <table className="documents-table">
                        <thead>
                          <tr>
                            <th>ชื่อเอกสาร</th>
                            <th>สถานะ</th>
                            <th>แก้ไขล่าสุด</th>
                            <th>ขนาด</th>
                            <th aria-label="การดำเนินการ" />
                          </tr>
                        </thead>
                        <tbody>
                          {visible.map((doc) => (
                            <tr key={doc.id}>
                              <td>
                                <button
                                  className="document-name"
                                  onClick={() => (view === 'trash' ? undefined : setEditing(doc))}
                                >
                                  <span
                                    className={`file-icon ${doc.status === 'signed' ? 'green-file' : ''}`}
                                  >
                                    <FileText size={22} />
                                    <small>PDF</small>
                                  </span>
                                  <span>
                                    <strong>{doc.title}</strong>
                                    <small>
                                      {doc.pages} หน้า <span>·</span> {doc.revisions.length}{' '}
                                      ฉบับที่จัดเก็บ
                                    </small>
                                  </span>
                                </button>
                              </td>
                              <td>
                                <Status
                                  signed={doc.status === 'signed'}
                                  testOnly={session.mode === 'demo'}
                                />
                              </td>
                              <td className="date-cell">{date(doc.updatedAt, true)}</td>
                              <td className="size-cell">{formatBytes(doc.bytes)}</td>
                              <td>
                                <DocumentMenu
                                  doc={doc}
                                  trash={view === 'trash'}
                                  onEdit={() => setEditing(doc)}
                                  onChanged={() => void load()}
                                  toast={toast}
                                />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <footer className="panel-footer">
                    <span>
                      <LockKeyhole size={13} />
                      เอกสารเข้าถึงได้เฉพาะบัญชีของคุณ
                    </span>
                    <span>แสดง {visible.length} รายการ</span>
                  </footer>
                </section>
                <p className="workspace-footnote">
                  <ShieldAlert size={14} />
                  {session.mode === 'demo'
                    ? 'โหมดทดลองใช้ใบรับรอง Self-signed สำหรับทดสอบระบบ ยังไม่ใช่การลงนามด้วย TDID'
                    : signingProvider.configured
                      ? 'นำเข้าใบรับรอง TDID ในหน้าใบรับรองของฉัน แล้วลงทะเบียน Passkey เพื่อยืนยันการลงนาม'
                      : signingProvider.message}
                </p>
              </>
            )}
            {view === 'certificates' && (
              <Certificates
                items={certificates}
                provider={signingProvider}
                toast={toast}
                onChanged={() => void load()}
              />
            )}
            {view === 'verify' && <VerifyDocuments documents={documents} toast={toast} />}
            {view === 'security' && (
              <Security session={session} refreshSession={refreshSession} toast={toast} />
            )}
            {view === 'audit' && <Audit toast={toast} />}
            {drag && (
              <div className="drop-overlay">
                <Upload size={44} />
                <h2>วาง PDF เพื่ออัปโหลด</h2>
                <p>สูงสุด {maxUploadBytes / 1024 / 1024} MB · ไม่เกิน 300 หน้า</p>
              </div>
            )}
          </main>
        </div>
        <input
          hidden
          ref={fileInput}
          type="file"
          accept="application/pdf,.pdf"
          onChange={(e) => void upload(e.target.files?.[0])}
        />
      </div>
      {editing && (
        <Suspense
          fallback={
            <div className="editor-shell">
              <div className="loading-state">
                <LoaderCircle className="spin" />
                กำลังเปิดเครื่องมือเอกสาร
              </div>
            </div>
          }
        >
          <Editor
            key={editing.id}
            document={editing}
            certificates={certificates}
            session={session}
            onClose={() => setEditing(null)}
            onChanged={() => void load()}
            toast={toast}
          />
        </Suspense>
      )}
      {message && (
        <div className={`toast ${message.error ? 'error' : ''}`} role="status">
          {message.error ? <AlertTriangle size={19} /> : <CheckCircle2 size={19} />}
          <span>{message.text}</span>
          <button onClick={() => setMessage(null)} aria-label="ปิดข้อความ">
            <X size={16} />
          </button>
        </div>
      )}
      {help && (
        <Modal
          title={session?.mode === 'demo' ? 'พื้นที่ทดลอง PSTON' : 'พื้นที่เอกสาร PSTON'}
          onClose={() => setHelp(false)}
        >
          <p>
            {session?.mode === 'demo'
              ? 'พื้นที่นี้ให้ทดลองอัปโหลด จัดวางองค์ประกอบ ลงนามด้วยใบรับรองทดสอบ และตรวจหลักฐานได้ครบเส้นทาง'
              : 'จัดเก็บเอกสาร เตรียม PDF นำเข้าใบรับรอง TDID จาก P12/PFX และอนุมัติการลงนามด้วย Passkey'}
          </p>
          <div className="notice warning">
            {session?.mode === 'demo'
              ? 'ใบรับรองทดสอบไม่ใช่ TDID และไม่ให้หลักฐานเวลาที่รับรองโดย TSA'
              : 'เลือกนำเข้า P12 สำหรับลงนามเพื่อเชื่อมกุญแจ การเพิ่ม CER/CRT เพียงอย่างเดียวใช้ดูข้อมูลใบรับรอง'}
          </div>
          <p className="muted">
            รุ่นนี้ยังไม่มี Trusted Timestamp และหลักฐานสำหรับตรวจลายเซ็นระยะยาว
          </p>
          <button className="button primary full" onClick={() => setHelp(false)}>
            เข้าใจแล้ว
          </button>
        </Modal>
      )}
    </>
  );
}
const PenIcon = FileText;
function Stat({
  label,
  value,
  suffix,
  icon: Icon,
  note,
}: {
  label: string;
  value: string;
  suffix: string;
  icon: typeof FolderOpen;
  note: string;
}) {
  return (
    <div className="stat-card">
      <div className="stat-top">
        <span>{label}</span>
        <Icon size={18} />
      </div>
      <div className="stat-value">
        {value}
        <small>{suffix}</small>
      </div>
      <div className="stat-note">{note}</div>
    </div>
  );
}
function DocumentMenu({
  doc,
  trash,
  onEdit,
  onChanged,
  toast,
}: {
  doc: DocumentRecord;
  trash: boolean;
  onEdit: () => void;
  onChanged: () => void;
  toast: Toast;
}) {
  return (
    <details className="document-menu">
      <summary aria-label={`เมนู ${doc.title}`}>
        <MoreHorizontal size={20} />
      </summary>
      <div>
        {trash ? (
          <button
            onClick={async () => {
              try {
                await api(`/documents/${doc.id}/restore`, { method: 'POST', body: {} });
                toast('กู้คืนเอกสารแล้ว');
                onChanged();
              } catch (e) {
                toast((e as Error).message, true);
              }
            }}
          >
            <RotateCcw size={15} />
            กู้คืนเอกสาร
          </button>
        ) : (
          <>
            <button onClick={onEdit}>
              <ArrowUpRight size={15} />
              เปิดเอกสาร
            </button>
            <button
              onClick={() =>
                download(
                  `/api/documents/${doc.id}/revisions/${doc.revisions.at(-1)!.id}/file`,
                  doc.title,
                )
              }
            >
              <Download size={15} />
              ดาวน์โหลดฉบับล่าสุด
            </button>
            <button
              onClick={async () => {
                try {
                  await api(`/documents/${doc.id}/duplicate`, { method: 'POST', body: {} });
                  toast('สร้างสำเนาต้นฉบับแล้ว');
                  onChanged();
                } catch (e) {
                  toast((e as Error).message, true);
                }
              }}
            >
              <Copy size={15} />
              สร้างสำเนาต้นฉบับ
            </button>
            <button
              className="danger-text"
              onClick={async () => {
                try {
                  await api(`/documents/${doc.id}`, { method: 'DELETE' });
                  toast('ย้ายเอกสารลงถังขยะแล้ว');
                  onChanged();
                } catch (e) {
                  toast((e as Error).message, true);
                }
              }}
            >
              <Trash2 size={15} />
              ย้ายลงถังขยะ
            </button>
          </>
        )}
      </div>
    </details>
  );
}
function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop">
      <section className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <h2>{title}</h2>
          <button className="icon-button" aria-label="ปิด" onClick={onClose}>
            <X />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

function Login({
  mode,
  error,
  onDemo,
}: {
  mode: string;
  error: string;
  onDemo: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="login-page">
      <section className="login-art">
        <Brand light />
        <div className="login-message">
          <div className="eyebrow">YOUR SIGNATURE. YOUR SPACE.</div>
          <h1>
            ทุกเอกสารมีที่อยู่
            <br />
            ทุกลายเซ็นมีหลักฐาน<span>.</span>
          </h1>
          <p>
            พื้นที่ส่วนตัวสำหรับจัดเตรียม ลงนาม
            <br />
            และตรวจสอบเอกสารฉบับสำคัญของคุณ
          </p>
        </div>
        <div className="login-document">
          <div className="login-document-top">
            <span>PSTON</span>
            <ShieldCheck size={25} />
          </div>
          <div className="skeleton-line wide" />
          <div className="skeleton-line" />
          <div className="skeleton-line" />
          <div className="skeleton-line short" />
          <div className="signature-art">Pston.</div>
          <div className="document-seal">
            <Check size={17} /> DOCUMENT INTEGRITY
          </div>
        </div>
        <div className="login-footer">
          <LockKeyhole size={16} />
          พื้นที่ส่วนตัว · ควบคุมได้ทุกฉบับ
        </div>
      </section>
      <section className="login-form">
        <div>
          <div className="eyebrow">WELCOME TO PSTON</div>
          <h2>เปิดพื้นที่เอกสารของคุณ</h2>
          <p className="muted">เข้าสู่ระบบเพื่อจัดการเอกสารและอนุมัติการลงนาม</p>
          {error && <div className="notice warning">{error}</div>}
          <a className="button google-button full" href="/api/auth/google/start">
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <path
                fill="#4285F4"
                d="M21.6 12.2c0-.7-.1-1.4-.2-2.1H12v4h5.4a4.6 4.6 0 0 1-2 3v2.6h3.2c1.9-1.8 3-4.4 3-7.5Z"
              />
              <path
                fill="#34A853"
                d="M12 22c2.7 0 5-.9 6.7-2.4l-3.2-2.5c-.9.6-2.1 1-3.5 1a6 6 0 0 1-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22Z"
              />
              <path fill="#FBBC05" d="M6.4 14a6 6 0 0 1 0-4V7.4H3.1a10 10 0 0 0 0 9.2L6.4 14Z" />
              <path
                fill="#EA4335"
                d="M12 5.9c1.5 0 2.8.5 3.8 1.5l2.9-2.9A10 10 0 0 0 3.1 7.4L6.4 10A6 6 0 0 1 12 5.9Z"
              />
            </svg>
            ดำเนินการต่อด้วย Google
          </a>
          <p className="tiny muted centered">เฉพาะบัญชีที่เจ้าของระบบอนุญาต</p>
          {mode === 'demo' && (
            <>
              <div className="or-divider">
                <span />
                หรือทดลองใช้งาน
                <span />
              </div>
              <button
                className="button primary full"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  await onDemo();
                  setBusy(false);
                }}
              >
                {busy ? <LoaderCircle className="spin" size={17} /> : <ArrowRight size={17} />}
                เปิดพื้นที่ทดลอง
              </button>
              <div className="login-demo-note">
                <ShieldAlert size={17} />
                <span>
                  ใช้เอกสารตัวอย่างและใบรับรองทดสอบ
                  <br />
                  ยังไม่ใช่การลงนามด้วย TDID
                </span>
              </div>
            </>
          )}
          <div className="login-features">
            <span>
              <FileCheck2 size={16} />
              เก็บต้นฉบับแยกทุกฉบับ
            </span>
            <span>
              <Fingerprint size={16} />
              อนุมัติเป็นรายธุรกรรม
            </span>
          </div>
        </div>
      </section>
    </div>
  );
}

function Certificates({
  items,
  provider,
  toast,
  onChanged,
}: {
  items: CertificateProfile[];
  provider: { configured: boolean; message: string };
  toast: Toast;
  onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [label, setLabel] = useState('');
  const [pem, setPem] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">SIGNING IDENTITIES</div>
          <h1>
            ใบรับรองของฉัน<span className="heading-dot">.</span>
          </h1>
          <p>ตรวจสอบข้อมูลใบรับรองและความพร้อมในการลงนาม</p>
        </div>
        <div className="actions">
          {provider.configured && (
            <button className="button primary" onClick={() => setImporting(true)}>
              <Upload size={17} />
              นำเข้า P12 สำหรับลงนาม
            </button>
          )}
          <button className="button secondary" onClick={() => setAdding(true)}>
            <Plus size={17} />
            เพิ่มใบรับรองสาธารณะ
          </button>
        </div>
      </div>
      <div className="certificate-grid">
        {items.map((cert) => (
          <article className="certificate-card" key={cert.id}>
            <div className="certificate-top">
              <span className="certificate-icon">
                <ShieldCheck size={27} />
              </span>
              <span className={`status ${cert.testOnly ? 'draft' : 'neutral'}`}>
                {cert.testOnly
                  ? 'TEST CERTIFICATE'
                  : cert.canSign
                    ? 'พร้อมลงนาม'
                    : 'CERTIFICATE ONLY'}
              </span>
            </div>
            <h2>{cert.label}</h2>
            <p className="certificate-subject">{cert.subject}</p>
            <dl className="detail-list">
              <div>
                <dt>อัลกอริทึม</dt>
                <dd>{cert.algorithm.toUpperCase()}</dd>
              </div>
              <div>
                <dt>วันหมดอายุ</dt>
                <dd>{date(cert.validTo)}</dd>
              </div>
              <div>
                <dt>ความสามารถ</dt>
                <dd>
                  {cert.canSign
                    ? cert.testOnly
                      ? 'ลงนามทดสอบได้'
                      : 'ลงนามได้'
                    : 'ดูข้อมูลเท่านั้น'}
                </dd>
              </div>
            </dl>
            <div className="hash-card">
              <small>FINGERPRINT · SHA-256</small>
              <code>{cert.fingerprint}</code>
            </div>
            <div className={`notice ${cert.testOnly ? 'warning' : ''}`}>
              {cert.testOnly
                ? 'Self-signed สำหรับทดลองระบบ ไม่ใช่ใบรับรองจาก TDID'
                : cert.canSign
                  ? 'กุญแจอยู่ใน Cloud HSM · ยืนยันการลงนามด้วย Passkey'
                  : 'ไม่มี Private Key ที่เชื่อมกับ Signing Provider จึงยังใช้ลงนามไม่ได้'}
            </div>
          </article>
        ))}
        <article className="certificate-card pending-provider">
          <div className="provider-logo">
            TDID<span>THAI DIGITAL ID</span>
          </div>
          <h2>ลงนามด้วยใบรับรอง TDID</h2>
          <p>
            {provider.configured
              ? 'นำเข้าไฟล์ P12/PFX เพื่อเก็บกุญแจใน Cloud HSM และใช้ลงนาม PDF'
              : 'ยังไม่ได้ตั้งค่าระบบลงนาม TDID'}
          </p>
          <span className="status neutral">
            <Clock3 size={13} />
            {items.some((cert) => cert.canSign && !cert.testOnly)
              ? 'มีใบรับรองพร้อมลงนาม'
              : provider.message}
          </span>
          <a
            href="https://www.thaidigitalid.com/product-service/"
            target="_blank"
            rel="noreferrer"
            className="text-button"
          >
            ข้อมูลผลิตภัณฑ์ TDID
            <ExternalLink size={14} />
          </a>
        </article>
      </div>
      {importing && (
        <Modal title="นำเข้าใบรับรองสำหรับลงนาม" onClose={() => setImporting(false)}>
          <ImportCertificate
            onDone={() => {
              setImporting(false);
              onChanged();
              toast('นำเข้าใบรับรองและเชื่อมกุญแจ HSM สำเร็จ');
            }}
          />
        </Modal>
      )}
      {adding && (
        <Modal title="เพิ่มใบรับรองสาธารณะ" onClose={() => setAdding(false)}>
          <p className="muted small">
            ใช้เพื่อดูข้อมูลใบรับรองเท่านั้น รับเฉพาะไฟล์ CER/CRT/PEM ที่ไม่มี Private Key
          </p>
          <label className="field">
            ชื่อใบรับรอง
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="เช่น TDID ส่วนตัว"
            />
          </label>
          <label className="field">
            เลือกไฟล์ใบรับรอง
            <input
              type="file"
              accept=".cer,.crt,.pem"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (file) {
                  if (file.size > 100000) {
                    toast('ใบรับรองมีขนาดใหญ่เกินกำหนด', true);
                    return;
                  }
                  const text = await file.text();
                  setPem(
                    text.includes('BEGIN CERTIFICATE')
                      ? text
                      : '-----BEGIN CERTIFICATE-----\n' +
                          btoa(String.fromCharCode(...new Uint8Array(await file.arrayBuffer()))) +
                          '\n-----END CERTIFICATE-----',
                  );
                  if (!label) setLabel(file.name);
                }
              }}
            />
          </label>
          <label className="field">
            PEM
            <textarea
              rows={6}
              value={pem}
              onChange={(e) => setPem(e.target.value)}
              placeholder="-----BEGIN CERTIFICATE-----"
            />
          </label>
          <button
            className="button primary full"
            disabled={busy || !label || !pem}
            onClick={async () => {
              setBusy(true);
              try {
                await api('/certificates', { method: 'POST', body: { label, pem } });
                toast('เพิ่มข้อมูลใบรับรองแล้ว');
                setAdding(false);
                setPem('');
                setLabel('');
                onChanged();
              } catch (e) {
                toast((e as Error).message, true);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}เพิ่มใบรับรอง
          </button>
        </Modal>
      )}
    </>
  );
}

function VerifyDocuments({ documents, toast }: { documents: DocumentRecord[]; toast: Toast }) {
  const [hash, setHash] = useState('');
  const [name, setName] = useState('');
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  const match = documents.find((d) => d.revisions.some((r) => r.sha256 === hash));
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">DOCUMENT VERIFICATION</div>
          <h1>
            ตรวจสอบเอกสาร<span className="heading-dot">.</span>
          </h1>
          <p>ตรวจความตรงกันของไฟล์ และผลลายเซ็นของฉบับที่จัดเก็บ</p>
        </div>
      </div>
      <div className="two-panel">
        <section className="content-panel">
          <h2>
            <FileSearch size={20} />
            เทียบ Hash ของไฟล์ในเครื่อง
          </h2>
          <p className="muted">คำนวณ SHA-256 ในเบราว์เซอร์ เนื้อหาไฟล์จะไม่ถูกส่งขึ้นระบบ</p>
          <label className="file-drop-input">
            <Upload size={25} />
            <strong>{name || 'เลือกไฟล์ PDF เพื่อตรวจสอบ'}</strong>
            <span>เทียบกับฉบับที่อยู่ใน Vault ของคุณ</span>
            <input
              type="file"
              accept=".pdf"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (file) {
                  if (file.size > 50 * 1024 * 1024) {
                    toast('ไฟล์เกิน 50 MB', true);
                    return;
                  }
                  setName(file.name);
                  setHash(await fileHash(file));
                }
              }}
            />
          </label>
          {hash && (
            <>
              <div className="hash-card">
                <small>SHA-256</small>
                <code>{hash}</code>
              </div>
              <div className={`notice ${match ? 'success' : 'warning'}`}>
                {match ? (
                  <>
                    <CheckCircle2 size={19} />
                    <span>
                      ไฟล์ตรงทุกไบต์กับฉบับในระบบ
                      <br />
                      <strong>{match.title}</strong>
                    </span>
                  </>
                ) : (
                  <>
                    <AlertTriangle size={19} />
                    <span>
                      ไม่พบไฟล์ที่ตรงทุกไบต์ในรายการปัจจุบัน
                      ไม่ได้แปลว่าลายเซ็นเสียหรือเอกสารถูกปลอม
                    </span>
                  </>
                )}
              </div>
            </>
          )}
          <p className="tiny muted">
            Hash ที่ตรงกันยืนยันความตรงกันของไฟล์ การตรวจลายเซ็นและความน่าเชื่อถือเป็นคนละขั้นตอน
          </p>
        </section>
        <section className="content-panel">
          <h2>
            <ShieldCheck size={20} />
            ตรวจลายเซ็นฉบับที่เก็บไว้
          </h2>
          <p className="muted">ระบบตรวจ CMS ด้วย OpenSSL และตรวจ SHA-256 อีกครั้ง</p>
          {documents.filter((d) => d.status === 'signed').length === 0 ? (
            <Empty
              icon={ShieldCheck}
              title="ยังไม่มีฉบับลงนาม"
              description="เอกสารที่ลงนามแล้วจะปรากฏที่นี่"
            />
          ) : (
            <div className="verification-list">
              {documents
                .filter((d) => d.status === 'signed')
                .map((doc) => (
                  <button
                    key={doc.id}
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        setResult(
                          await api(`/documents/${doc.id}/verify`, {
                            method: 'POST',
                            body: { revisionId: doc.revisions.at(-1)!.id },
                          }),
                        );
                      } catch (e) {
                        toast((e as Error).message, true);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    <FileText size={18} />
                    <span>{doc.title}</span>
                    <ArrowUpRight size={16} />
                  </button>
                ))}
            </div>
          )}
          {result && <ValidationResult result={result} />}
        </section>
      </div>
    </>
  );
}
function ValidationResult({ result }: { result: Record<string, unknown> }) {
  return (
    <div className="validation-result">
      <div>
        <span>ลายเซ็นเข้ารหัส</span>
        <strong className="green">
          {result.crypto === 'valid' ? 'ถูกต้อง' : 'ยังไม่ได้ลงนาม'}
        </strong>
      </div>
      <div>
        <span>ความน่าเชื่อถือของ CA</span>
        <strong className={result.trust === 'trusted' ? 'green' : 'amber'}>
          {result.trust === 'trusted' ? 'ผ่าน TDID / NRCA' : 'ยังไม่ยืนยัน'}
        </strong>
      </div>
      <div>
        <span>สถานะเพิกถอน</span>
        <strong>
          {result.revocation === 'good'
            ? 'ไม่พบการเพิกถอน ณ เวลาตรวจ'
            : result.revocation === 'unknown'
              ? 'ตรวจสอบไม่ได้'
              : 'ยังไม่ได้ตรวจ'}
        </strong>
      </div>
      <div>
        <span>Trusted Timestamp</span>
        <strong>ไม่มี</strong>
      </div>
      <div className="hash-card">
        <small>SHA-256</small>
        <code>{String(result.sha256 ?? '')}</code>
      </div>
    </div>
  );
}

function Security({
  session,
  refreshSession,
  toast,
}: {
  session: Session;
  refreshSession: () => Promise<void>;
  toast: Toast;
}) {
  const [state, setState] = useState<{
    locked: boolean;
    provider: string;
    productionSigningReady?: boolean;
  } | null>(null);
  const [services, setServices] = useState<{ name: string; status: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    void api<{ locked: boolean; provider: string }>('/security')
      .then(setState)
      .catch((e) => toast(e.message, true));
    void api<{ services: typeof services }>('/system')
      .then((r) => setServices(r.services))
      .catch((e) => toast(e.message, true));
  }, []);
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">SECURITY CENTER</div>
          <h1>
            ศูนย์ความปลอดภัย<span className="heading-dot">.</span>
          </h1>
          <p>ควบคุมสิทธิ์อนุมัติและระงับการลงนามได้จากที่เดียว</p>
        </div>
      </div>
      <div className="two-panel">
        <section className="content-panel">
          <div className="section-icon">
            <Fingerprint size={29} />
          </div>
          <h2>Passkey สำหรับอนุมัติ</h2>
          <p className="muted">
            ใช้ลายนิ้วมือ ใบหน้า หรืออุปกรณ์ยืนยันตัวตน เพื่ออนุมัติเอกสารแต่ละฉบับ
          </p>
          <span className={`status ${session.passkeys ? 'signed' : 'draft'}`}>
            {session.passkeys ? 'ลงทะเบียนแล้ว' : 'ยังไม่ได้ลงทะเบียน'}
          </span>
          <button
            className="button primary full mt"
            disabled={busy || session.passkeys > 0}
            onClick={async () => {
              setBusy(true);
              try {
                const options = await api<PublicKeyCredentialCreationOptionsJSON>(
                  '/webauthn/register/options',
                  { method: 'POST', body: {} },
                );
                const response = await startRegistration({ optionsJSON: options });
                await api('/webauthn/register/verify', { method: 'POST', body: response });
                await refreshSession();
                toast('ลงทะเบียน Passkey สำเร็จ');
              } catch (e) {
                toast((e as Error).message, true);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <LoaderCircle className="spin" size={16} /> : <Fingerprint size={17} />}
            ลงทะเบียน Passkey
          </button>
          <p className="tiny muted">การเพิ่ม Passkey ถัดไปและ Recovery ยังไม่เปิดใช้งานในรุ่นนี้</p>
        </section>
        <section className="content-panel emergency-panel">
          <div className="section-icon">
            <ShieldAlert size={29} />
          </div>
          <h2>ระงับการลงนาม</h2>
          <p className="muted">
            หยุดการเริ่มลงนามใหม่ทันทีเมื่อพบเหตุผิดปกติ เอกสารเดิมยังเปิดอ่านและดาวน์โหลดได้
          </p>
          <span className={`status ${state?.locked ? 'draft' : 'signed'}`}>
            {state?.locked
              ? 'ระงับอยู่'
              : state
                ? session.mode === 'demo'
                  ? 'พร้อมลงนามทดสอบ'
                  : state.productionSigningReady
                    ? 'มีใบรับรองพร้อมลงนาม'
                    : 'ยังไม่มีใบรับรองพร้อมลงนาม'
                : 'กำลังตรวจสถานะ'}
          </span>
          <button
            className={`button full mt ${state?.locked ? 'secondary' : 'danger-light'}`}
            disabled={!state}
            onClick={() => setConfirm(true)}
          >
            <LockKeyhole size={17} />
            {state?.locked ? 'เปิดการลงนามทดสอบอีกครั้ง' : 'ระงับการลงนาม'}
          </button>
          <p className="tiny muted">การระงับใน PSTON ไม่ใช่การเพิกถอนใบรับรองกับ TDID</p>
        </section>
      </div>
      <section className="content-panel mt">
        <h2>สถานะบริการ</h2>
        <div className="services-grid">
          {services.map((s) => (
            <div className="service-status" key={s.name}>
              <span className={s.status === 'ok' ? 'online-dot' : 'offline-dot'} />
              <strong>{s.name}</strong>
              <span>{s.status === 'ok' ? 'พร้อมใช้งาน' : 'ไม่พร้อมใช้งาน'}</span>
            </div>
          ))}
        </div>
      </section>
      {confirm && (
        <Modal
          title={state?.locked ? 'เปิดลงนามทดสอบอีกครั้ง' : 'ระงับการลงนาม'}
          onClose={() => setConfirm(false)}
        >
          <p>
            {state?.locked
              ? 'ยืนยันการเปิดใช้กุญแจทดสอบในพื้นที่ทดลองนี้อีกครั้ง'
              : 'รายการลงนามใหม่จะถูกปฏิเสธ เอกสารที่เก็บไว้ยังคงอยู่ครบ'}
          </p>
          <button
            className="button primary full"
            onClick={async () => {
              try {
                const next = await api<{ locked: boolean }>('/security/lock', {
                  method: 'POST',
                  body: { locked: !state?.locked },
                });
                setState((s) => (s ? { ...s, ...next } : null));
                setConfirm(false);
                toast(next.locked ? 'ระงับการลงนามแล้ว' : 'เปิดการลงนามทดสอบแล้ว');
              } catch (e) {
                toast((e as Error).message, true);
              }
            }}
          >
            ยืนยัน
          </button>
        </Modal>
      )}
    </>
  );
}

function Audit({ toast }: { toast: Toast }) {
  const [events, setEvents] = useState<AuditRecord[]>([]);
  const [checking, setChecking] = useState(false);
  const [loading, setLoading] = useState(true);
  async function load() {
    try {
      const result = await api<{ events: AuditRecord[] }>('/audit/events');
      setEvents(result.events);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    const interval = setInterval(() => void load(), 5000);
    return () => clearInterval(interval);
  }, []);
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">ACTIVITY & EVIDENCE</div>
          <h1>
            บันทึกกิจกรรม<span className="heading-dot">.</span>
          </h1>
          <p>ติดตามเหตุการณ์และหลักฐานของเอกสารในพื้นที่ของคุณ</p>
        </div>
        <button
          className="button secondary"
          disabled={checking}
          onClick={async () => {
            setChecking(true);
            try {
              const result = await api<{ valid: boolean; checked: number }>('/audit/integrity');
              toast(
                result.valid
                  ? `Hash chain ผ่านการตรวจสอบ ${result.checked} เหตุการณ์ · ตรวจในระบบนี้เท่านั้น`
                  : 'ตรวจพบความไม่ต่อเนื่องของ Audit',
                !result.valid,
              );
            } catch (e) {
              toast((e as Error).message, true);
            } finally {
              setChecking(false);
            }
          }}
        >
          {checking ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}
          ตรวจความต่อเนื่อง
        </button>
      </div>
      <section className="content-panel audit-panel">
        <div className="panel-top">
          <h2>
            กิจกรรมล่าสุด<span>{events.length}</span>
          </h2>
          <button className="icon-button" aria-label="รีเฟรช" onClick={() => void load()}>
            <RefreshCw size={17} />
          </button>
        </div>
        {loading ? (
          <div className="loading-state">
            <LoaderCircle className="spin" />
          </div>
        ) : events.length === 0 ? (
          <Empty
            icon={History}
            title="ยังไม่มีเหตุการณ์"
            description="เหตุการณ์จะถูกส่งมาจากบริการต่าง ๆ ภายในไม่กี่วินาที"
          />
        ) : (
          <div className="audit-list">
            {events.map((e) => (
              <div className="audit-row" key={e.id}>
                <div className={`audit-icon ${e.outcome === 'failure' ? 'warning' : ''}`}>
                  {e.type.includes('sign') ? (
                    <PenIcon size={17} />
                  ) : e.type.includes('auth') ? (
                    <KeyRound size={17} />
                  ) : (
                    <FileText size={17} />
                  )}
                </div>
                <div>
                  <strong>{eventNames[e.type] ?? e.type}</strong>
                  <small>
                    {e.service} <span>·</span> {e.resourceId.slice(0, 16)}…
                  </small>
                </div>
                <div className="audit-time">
                  <span>{date(e.occurredAt, true)}</span>
                  <code title={e.hash}>{e.hash.slice(0, 16)}…</code>
                </div>
                <span className={`status ${e.outcome === 'success' ? 'neutral' : 'draft'}`}>
                  {e.outcome === 'success' ? 'สำเร็จ' : 'ต้องตรวจสอบ'}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
      <p className="workspace-footnote">
        <Link size={14} />
        Hash chain นี้ยังไม่มี Checkpoint จากแหล่งอิสระภายนอก
        จึงไม่ใช่หลักฐานป้องกันผู้ดูแลแก้ข้อมูลได้ทั้งหมด
      </p>
    </>
  );
}

async function fileHash(file: File) {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((n) => n.toString(16).padStart(2, '0')).join('');
}
function PublicVerify({ id }: { id: string }) {
  const [record, setRecord] = useState<{
    sha256: string;
    createdAt: string;
    testOnly: boolean;
  } | null>(null);
  const [error, setError] = useState('');
  const [match, setMatch] = useState<boolean | null>(null);
  const [filename, setFilename] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<typeof record>(`/verify/${encodeURIComponent(id)}`)
      .then(setRecord)
      .catch((e) => setError(e.message));
  }, [id]);
  return (
    <div className="public-verify">
      <header>
        <Brand />
        <a href="/" className="text-button">
          เปิดพื้นที่เอกสาร
          <ArrowUpRight size={15} />
        </a>
      </header>
      <main>
        <div className="verification-emblem">
          <ShieldCheck size={38} />
        </div>
        <div className="eyebrow">PSTON VERIFICATION RECORD</div>
        <h1>ตรวจสอบหลักฐานเอกสาร</h1>
        <p className="muted">หน้านี้แสดงเฉพาะหลักฐานที่ระบบจัดเก็บไว้ ไม่เปิดเผยไฟล์เอกสาร</p>
        {error ? (
          <div className="notice warning">{error}</div>
        ) : !record ? (
          <LoaderCircle className="spin" />
        ) : (
          <section className="content-panel">
            {record.testOnly && (
              <div className="notice warning">
                เอกสารนี้ลงนามด้วยใบรับรองทดสอบ Self-signed ไม่ใช่ TDID
              </div>
            )}
            <dl className="detail-list">
              <div>
                <dt>บันทึกเมื่อ</dt>
                <dd>{date(record.createdAt, true)}</dd>
              </div>
              <div>
                <dt>เวลาจาก TSA</dt>
                <dd>ไม่มีหลักฐาน</dd>
              </div>
            </dl>
            <div className="hash-card">
              <small>SHA-256 · ฉบับที่ระบบเก็บไว้</small>
              <code>{record.sha256}</code>
            </div>
            <label className="file-drop-input">
              <Upload size={24} />
              <strong>
                {busy ? 'กำลังตรวจสอบ…' : filename || 'เลือกไฟล์เพื่อตรวจว่าตรงกันหรือไม่'}
              </strong>
              <span>คำนวณ Hash ในเครื่อง ไม่ส่งเนื้อหาไฟล์</span>
              <input
                disabled={busy}
                type="file"
                accept=".pdf"
                onChange={async (e: ChangeEvent<HTMLInputElement>) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  setBusy(true);
                  try {
                    if (file.size > 50 * 1024 * 1024) throw new Error('ไฟล์เกิน 50 MB');
                    setFilename(file.name);
                    const hash = await fileHash(file);
                    const result = await api<{ matches: boolean }>(
                      `/verify/${encodeURIComponent(id)}/check`,
                      { method: 'POST', body: { sha256: hash } },
                    );
                    setMatch(result.matches);
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              />
            </label>
            {match !== null && (
              <div className={`notice ${match ? 'success' : 'warning'}`}>
                {match ? <CheckCircle2 size={20} /> : <AlertTriangle size={20} />}
                <span>
                  {match
                    ? 'ไฟล์ตรงทุกไบต์กับฉบับที่ระบบเก็บไว้'
                    : 'ไฟล์ไม่ตรงกับฉบับที่เก็บไว้ อาจเป็นฉบับอื่นหรือมีการลงนามเพิ่มเติม'}
                </span>
              </div>
            )}
            <p className="tiny muted">
              การสแกน QR อย่างเดียวไม่ยืนยันไฟล์ในมือ ระบบไม่ทราบการลงนามภายนอกที่ไม่ได้ส่งกลับ
              และการเทียบ Hash ไม่ใช่การตรวจความน่าเชื่อถือของ CA
            </p>
          </section>
        )}
      </main>
    </div>
  );
}
