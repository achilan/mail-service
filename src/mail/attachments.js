// Resolución y validación de adjuntos (base64 o URL segura).

import path from 'node:path';
import { HttpError } from '../http.js';
import { safeFetch } from '../security/ssrf.js';

// Tipos de archivo aceptados. Ejecutables, scripts y HTML quedan fuera.
const ALLOWED_TYPES = {
  '.pdf': 'application/pdf',
  '.xml': 'application/xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.ics': 'text/calendar',
  '.zip': 'application/zip',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

// Nombre de archivo seguro: sin rutas, sin caracteres de control, longitud acotada.
export function safeFilename(name, fallback = 'adjunto') {
  const base = path.basename(String(name || '')).normalize('NFKC');
  const clean = base.replace(/[^\w.\- ()áéíóúñÁÉÍÓÚÑ]/g, '_').replace(/^\.+/, '').slice(0, 150);
  return clean || fallback;
}

const isBase64 = (s) => typeof s === 'string' && /^[A-Za-z0-9+/\s]*={0,2}$/.test(s);

export function decodeBase64(value, label, maxBytes) {
  if (!isBase64(value)) throw new HttpError(400, 'invalid_attachment', `${label}: base64 inválido`);
  const buf = Buffer.from(value, 'base64');
  if (buf.length === 0) throw new HttpError(400, 'invalid_attachment', `${label}: archivo vacío`);
  if (buf.length > maxBytes) throw new HttpError(413, 'attachment_too_large', `${label}: supera el tamaño máximo`);
  return buf;
}

// Obtiene el contenido como Buffer desde base64 o desde una URL (con protección SSRF).
export async function resolveContent({ base64, url }, label, opts) {
  if (base64) return decodeBase64(base64, label, opts.maxBytes);
  if (url) {
    const { buffer } = await safeFetch(url, opts);
    if (buffer.length === 0) throw new Error(`${label}: archivo vacío`);
    return buffer;
  }
  return null;
}

// Para la API v1: lista genérica de adjuntos.
export async function resolveAttachments(list, opts) {
  if (list.length > opts.maxCount) throw new HttpError(400, 'too_many_attachments', `Máximo ${opts.maxCount} adjuntos`);
  const out = [];
  let total = 0;
  for (const [i, a] of list.entries()) {
    const filename = safeFilename(a.filename, `adjunto-${i + 1}`);
    const ext = path.extname(filename).toLowerCase();
    if (!ALLOWED_TYPES[ext]) throw new HttpError(400, 'attachment_type_not_allowed', `Tipo de archivo no permitido: ${ext || '(sin extensión)'}`);
    const content = await resolveContent({ base64: a.contentBase64, url: a.url }, filename, opts);
    total += content.length;
    if (total > opts.maxBytes * 2) throw new HttpError(413, 'attachment_too_large', 'Los adjuntos superan el tamaño total máximo');
    out.push({ filename, content, contentType: ALLOWED_TYPES[ext] });
  }
  return out;
}
