// Validación de entradas: destinatarios, asuntos y schemas zod de la API v1.

import addressparser from 'nodemailer/lib/addressparser';
import { z } from 'zod';
import { HttpError } from './http.js';

// RFC 5321 práctico: local@dominio.tld, sin espacios ni caracteres de control.
const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export const isEmail = (s) => typeof s === 'string' && s.length <= 254 && EMAIL_RE.test(s);

// Acepta lo mismo que antes ("a@b.com", "Juan <a@b.com>", "a@b.com, c@d.com")
// y además arrays. Devuelve la lista de direcciones o null si algo es inválido.
export function parseRecipients(value) {
  if (value === undefined || value === null || value === '') return [];
  const raw = Array.isArray(value) ? value : [value];
  const out = [];
  for (const item of raw) {
    if (typeof item !== 'string' || /[\r\n\0]/.test(item) || item.length > 2000) return null;
    for (const parsed of addressparser(item, { flatten: true })) {
      if (!isEmail(parsed.address)) return null;
      out.push(parsed.name ? { name: parsed.name.replace(/["\\]/g, ''), address: parsed.address } : parsed.address);
    }
  }
  return out;
}

const addressOf = (r) => (typeof r === 'string' ? r : r.address);

// Valida to/cc/bcc juntos: formato, cantidad total y dominios permitidos.
export function checkRecipients({ to, cc, bcc }, { maxRecipients, allowedRecipientDomains }) {
  const lists = { to: parseRecipients(to), cc: parseRecipients(cc), bcc: parseRecipients(bcc) };
  if (!lists.to || lists.to.length === 0 || !lists.cc || !lists.bcc) {
    throw new HttpError(400, 'invalid_recipient', 'Invalid recipient');
  }
  const all = [...lists.to, ...lists.cc, ...lists.bcc];
  if (all.length > maxRecipients) {
    throw new HttpError(400, 'too_many_recipients', `Máximo ${maxRecipients} destinatarios por correo`);
  }
  if (allowedRecipientDomains.length) {
    const blocked = all.map(addressOf).find((a) => !allowedRecipientDomains.includes(a.split('@')[1].toLowerCase()));
    if (blocked) throw new HttpError(400, 'recipient_domain_not_allowed', 'Invalid recipient');
  }
  return {
    to: lists.to,
    cc: lists.cc.length ? lists.cc : undefined,
    bcc: lists.bcc.length ? lists.bcc : undefined,
  };
}

// Evita inyección de cabeceras y asuntos absurdamente largos.
export const cleanSubject = (s) => String(s).replace(/[\r\n\t\0]+/g, ' ').trim().slice(0, 300);

export const TEMPLATE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// ───────────────────────────── Schemas v1 ─────────────────────────────

const recipients = z.union([z.string().max(2000), z.array(z.string().max(320)).max(100)]);
const context = z.record(z.string(), z.unknown()).default({});

export const attachmentSchema = z.object({
  filename: z.string().min(1).max(200),
  contentBase64: z.string().max(40 * 1024 * 1024).optional(),
  url: z.string().url().max(2048).optional(),
  contentType: z.string().max(100).optional(),
}).refine((a) => Boolean(a.contentBase64) !== Boolean(a.url), {
  message: 'Cada adjunto requiere contentBase64 o url (solo uno)',
});

export const emailSchema = z.object({
  to: recipients,
  cc: recipients.optional(),
  bcc: recipients.optional(),
  replyTo: z.string().max(320).optional(),
  subject: z.string().min(1).max(300).optional(),
  template: z.string().regex(TEMPLATE_NAME, 'Nombre de plantilla inválido').default('generic'),
  context,
  preheader: z.string().max(200).optional(),
  attachments: z.array(attachmentSchema).max(20).default([]),
  headers: z.record(z.string().regex(/^X-[A-Za-z0-9-]{1,60}$/, 'Solo cabeceras X-*'), z.string().max(500)).optional(),
  unsubscribeUrl: z.string().url().max(2048).optional(),
  tags: z.array(z.string().max(50)).max(10).optional(),
});

export const batchSchema = z.object({
  messages: z.array(emailSchema).min(1).max(100),
});

export const templateWriteSchema = z.object({
  html: z.string().min(1).max(200_000),
  subject: z.string().max(300).optional(),
  description: z.string().max(500).optional(),
  layout: z.string().regex(/^([a-z0-9][a-z0-9_-]{0,63}|none)$/).optional(),
  sampleData: z.record(z.string(), z.unknown()).optional(),
});

export const templatePatchSchema = templateWriteSchema.partial();

export const renderSchema = z.object({
  context: z.record(z.string(), z.unknown()).optional(),
  subject: z.string().max(300).optional(),
  preheader: z.string().max(200).optional(),
  format: z.enum(['json', 'html']).default('json'),
});

export const validateTemplateSchema = templateWriteSchema.extend({
  kind: z.enum(['email', 'layout', 'partial']).default('email'),
  context: z.record(z.string(), z.unknown()).optional(),
});

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Color hex #RRGGBB');
const httpsUrl = z.string().max(2048).refine((v) => v === '' || /^https:\/\//i.test(v), 'Debe ser https://');

export const brandingSchema = z.object({
  name: z.string().min(1).max(100),
  logoUrl: httpsUrl,
  primaryColor: hex,
  accentColor: hex,
  website: httpsUrl,
  supportEmail: z.string().max(254).refine((v) => v === '' || isEmail(v), 'Email inválido'),
  address: z.string().max(300),
  footerNote: z.string().max(500),
  lang: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/),
  socialLinks: z.array(z.object({ label: z.string().min(1).max(40), url: httpsUrl })).max(8),
}).partial();
