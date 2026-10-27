import { useEffect, useRef, useState, type ReactNode } from 'react';
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist';
import worker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { LoaderCircle, FileWarning } from 'lucide-react';

GlobalWorkerOptions.workerSrc = worker;
export function PdfCanvas({
  url,
  page = 0,
  children,
  onPages,
  onScale,
}: {
  url: string;
  page?: number;
  children?: ReactNode;
  onPages?: (count: number) => void;
  onScale?: (scale: number) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState('');
  const [width, setWidth] = useState(600);
  const [height, setHeight] = useState(840);
  const [rendering, setRendering] = useState(true);
  const callbacks = useRef({ onPages, onScale });
  callbacks.current = { onPages, onScale };
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) =>
      setWidth(Math.min(780, Math.max(220, entries[0].contentRect.width))),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let alive = true;
    setPdf(null);
    setError('');
    setRendering(true);
    const abort = new AbortController();
    let task: ReturnType<typeof getDocument> | undefined;
    void fetch(url, { credentials: 'same-origin', signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('ไม่สามารถโหลดเอกสารได้');
        task = getDocument({ data: await response.arrayBuffer() });
        const doc = await task.promise;
        if (alive) {
          setPdf(doc);
          callbacks.current.onPages?.(doc.numPages);
        }
      })
      .catch((err) => {
        if (alive) setError((err as Error).message);
      });
    return () => {
      alive = false;
      abort.abort();
      if (task) void task.destroy();
    };
  }, [url]);
  useEffect(() => {
    if (!pdf || !canvas.current) return;
    let cancelled = false;
    let task: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | undefined;
    setRendering(true);
    void pdf
      .getPage(Math.min(page + 1, pdf.numPages))
      .then((pdfPage) => {
        if (cancelled || !canvas.current) return;
        const base = pdfPage.getViewport({ scale: 1 });
        const scale = width / base.width;
        callbacks.current.onScale?.(scale);
        const viewport = pdfPage.getViewport({ scale });
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        const c = canvas.current;
        c.width = Math.round(viewport.width * ratio);
        c.height = Math.round(viewport.height * ratio);
        setHeight(viewport.height);
        task = pdfPage.render({
          canvas: c,
          viewport,
          transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
        });
        return task.promise;
      })
      .then(() => {
        if (!cancelled) setRendering(false);
      })
      .catch((err) => {
        if (!cancelled && err.name !== 'RenderingCancelledException')
          setError('อ่านหน้า PDF ไม่สำเร็จ');
      });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [pdf, page, width]);
  return (
    <div ref={container} className="pdf-container">
      {error ? (
        <div className="empty-state">
          <FileWarning size={36} />
          <p>{error}</p>
        </div>
      ) : (
        <div className="pdf-paper" style={{ width, height }}>
          <canvas
            ref={canvas}
            style={{ width: '100%', height: '100%' }}
            aria-label={`เอกสาร PDF หน้า ${page + 1}`}
          />
          {!rendering && children}
          {rendering && (
            <div className="pdf-loading">
              <LoaderCircle className="spin" /> กำลังเปิดเอกสาร
            </div>
          )}
        </div>
      )}
    </div>
  );
}
