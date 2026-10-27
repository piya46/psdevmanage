let csrf = '';
export let maxUploadBytes = 50 * 1024 * 1024;
export function setCsrf(value: string) {
  csrf = value;
}
export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (!['GET', 'HEAD'].includes(method)) headers['x-csrf-token'] = csrf;
  let body: BodyInit | undefined;
  if (options.body instanceof FormData) body = options.body;
  else if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  const response = await fetch('/api' + path, {
    method,
    body,
    headers,
    credentials: 'same-origin',
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message ?? 'ไม่สามารถดำเนินการได้');
  if (typeof data.maxPdfBytes === 'number') maxUploadBytes = data.maxPdfBytes;
  return data as T;
}
export function formatBytes(bytes: number) {
  return bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(0)} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
export function date(value: string, withTime = false) {
  return new Intl.DateTimeFormat('th-TH', {
    day: 'numeric',
    month: 'short',
    year: '2-digit',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
    timeZone: 'Asia/Bangkok',
  }).format(new Date(value));
}
export function download(url: string, name = 'document.pdf') {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
