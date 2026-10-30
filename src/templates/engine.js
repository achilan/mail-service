// Motor de render: Handlebars aislado + helpers propios + layout + partials.
//
// Seguridad:
// - Entorno Handlebars propio (Handlebars.create), no el global.
// - knownHelpersOnly: una plantilla solo puede invocar los helpers listados aquí.
// - Acceso a prototipos deshabilitado (por defecto en Handlebars ≥ 4.6).
// - `{{{safe x}}}` sanitiza HTML dinámico; `{{safeUrl x}}` neutraliza javascript:.

import fs from 'node:fs/promises';
import path from 'node:path';
import Handlebars from 'handlebars';
import { HttpError } from '../http.js';
import { htmlToText } from '../mail/text.js';
import { safeUrl, sanitizeMessage } from '../security/sanitize.js';
import { CATALOG } from './catalog.js';
import { hasIcon, iconPng, iconsAvailable, iconSvg, normalizeColor } from './icon-render.js';

const MAX_OUTPUT = 2 * 1024 * 1024;

// Paleta semántica (texto, fondo suave, borde) — contraste AA sobre blanco.
export const TONES = {
  brand: null,
  success: { fg: '#067647', solid: '#12B76A', bg: '#ECFDF3', border: '#ABEFC6' },
  info: { fg: '#175CD3', solid: '#2E90FA', bg: '#EFF8FF', border: '#B2DDFF' },
  warning: { fg: '#B54708', solid: '#F79009', bg: '#FFFAEB', border: '#FEDF89' },
  danger: { fg: '#B42318', solid: '#F04438', bg: '#FEF3F2', border: '#FECDCA' },
  neutral: { fg: '#344054', solid: '#667085', bg: '#F2F4F7', border: '#E4E7EC' },
};

const HEX = /^#([0-9a-f]{6})$/i;

// Mezcla un color con blanco (amount 0..1) para tintes suaves de fondo/borde.
function tint(hex, amount) {
  const m = HEX.exec(hex || '');
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const mix = (c) => Math.round(c + (255 - c) * amount);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(mix);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1).toUpperCase()}`;
}

function toneColors(tone, brand) {
  if (TONES[tone]) return TONES[tone];
  const p = brand?.primaryColor || '#4F46E5';
  return { fg: p, solid: p, bg: tint(p, 0.92), border: tint(p, 0.75) };
}

const toNumber = (v) => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v.replace(/,/g, ''));
  return NaN;
};

const localeOf = (root) => (root?.brand?.lang === 'en' ? 'en-US' : `${root?.brand?.lang || 'es'}-EC`);

function registerHelpers(hb) {
  const helpers = {
    safe: (html) => new hb.SafeString(sanitizeMessage(html)),
    safeUrl: (url) => safeUrl(url),
    eq: (a, b) => a === b,
    ne: (a, b) => a !== b,
    gt: (a, b) => toNumber(a) > toNumber(b),
    and: (...args) => args.slice(0, -1).every(Boolean),
    or: (...args) => args.slice(0, -1).some(Boolean),
    not: (v) => !v,
    fallback: (v, fallback) => (v === undefined || v === null || v === '' ? fallback : v),
    upper: (v) => (v == null ? '' : String(v).toUpperCase()),
    initialOf: (v) => (v ? String(v).trim().charAt(0).toUpperCase() : 'M'),
    currentYear: () => new Date().getFullYear(),
    multiply: (a, b) => toNumber(a) * toNumber(b),
    inc: (n) => toNumber(n) + 1,
    formatMoney(value, currency, options) {
      const opts = options?.data ? options : currency;
      const cur = typeof currency === 'string' ? currency : 'USD';
      const n = toNumber(value);
      if (Number.isNaN(n)) return value ?? '';
      try {
        return new Intl.NumberFormat(localeOf(opts?.data?.root), { style: 'currency', currency: cur }).format(n);
      } catch {
        return n.toFixed(2);
      }
    },
    formatDate(value, style, options) {
      const opts = options?.data ? options : style;
      const fmt = typeof style === 'string' ? style : 'long';
      const d = value ? new Date(value) : new Date();
      if (Number.isNaN(d.getTime())) return value ?? '';
      const map = {
        long: { dateStyle: 'long' },
        short: { dateStyle: 'medium' },
        datetime: { dateStyle: 'long', timeStyle: 'short' },
        time: { timeStyle: 'short' },
      };
      return new Intl.DateTimeFormat(localeOf(opts?.data?.root), { ...(map[fmt] || map.long), timeZone: opts?.data?.root?.timezone || 'America/Guayaquil' }).format(d);
    },
    toneColor(tone, part, options) {
      const colors = toneColors(tone, options?.data?.root?.brand);
      return colors[part] || colors.fg;
    },
    tintColor: (hex, amount) => tint(hex, toNumber(amount)),
    // {{icon "lock" "#4F46E5" 24 inline=true}} — color y tamaño opcionales.
    icon(name, color, size, options) {
      const opts = [color, size, options].find((o) => o?.data);
      const root = opts?.data?.root || {};
      // Sin rasterizador no hay PNG para incrustar: se omite el ícono en vez de romper el envío.
      if (root._iconMode === 'cid' && !iconsAvailable()) return '';
      const n = hasIcon(name) ? name : 'mail';
      const c = normalizeColor(typeof color === 'string' ? color : root.brand?.primaryColor);
      const s = typeof size === 'number' ? Math.min(Math.max(size, 8), 128) : 24;
      const style = opts?.hash?.inline
        ? `display:inline-block;vertical-align:-4px;margin-right:6px;width:${s}px;height:${s}px;border:0;`
        : `display:block;width:${s}px;height:${s}px;border:0;outline:none;`;
      return new hb.SafeString(`<img src="${iconSrc(root, n, c, s)}" width="${s}" height="${s}" alt="" style="${style}">`);
    },
  };
  for (const [name, fn] of Object.entries(helpers)) hb.registerHelper(name, fn);
  return Object.fromEntries(Object.keys(helpers).map((k) => [k, true]));
}

// Origen de la imagen del ícono según el modo de render:
// cid  → PNG incrustado en el correo (funciona en Gmail/Outlook, sin servidor externo)
// url  → PNG servido por este servicio (requiere PUBLIC_URL accesible)
// data → SVG en data URI (vistas previas en el navegador)
function iconSrc(root, name, color, size) {
  if (root._iconMode === 'data') {
    return `data:image/svg+xml;base64,${Buffer.from(iconSvg(name, color, size)).toString('base64')}`;
  }
  if (root._iconMode === 'url' && root._iconBaseUrl) {
    return `${root._iconBaseUrl}/assets/icons/${name}.png?color=${color}&amp;size=${size}`;
  }
  const cid = `ic-${name}-${color}-${size}@mail-service`.toLowerCase();
  root._icons?.set(cid, { name, color, size });
  return `cid:${cid}`;
}

const COMPILE_OPTS = (knownHelpers) => ({ knownHelpers, knownHelpersOnly: true, preventIndent: true });

// Carga las plantillas incluidas en el repo según el catálogo.
export async function loadBuiltins(templatesDir) {
  const builtins = { email: {}, layout: {}, partial: {} };
  const dirs = { email: '', layout: 'layouts', partial: 'partials' };
  for (const [kind, entries] of Object.entries(CATALOG)) {
    for (const [name, meta] of Object.entries(entries)) {
      const html = await fs.readFile(path.join(templatesDir, dirs[kind], `${name}.hbs`), 'utf8');
      builtins[kind][name] = { layout: kind === 'email' ? 'base' : undefined, ...meta, html };
    }
  }
  return builtins;
}

export function createEngine({ store, legacy = {}, icons = {} }) {
  const defaultIconMode = icons.mode === 'url' && icons.publicUrl ? 'url' : 'cid';
  let env = null;

  function buildEnv() {
    const hb = Handlebars.create();
    const knownHelpers = registerHelpers(hb);
    const opts = COMPILE_OPTS(knownHelpers);
    for (const { name } of store.list('partial')) {
      hb.registerPartial(name, hb.compile(store.view('partial', name).html, opts));
    }
    return { hb, opts, cache: new Map() };
  }

  store.on('change', () => { env = null; });
  const getEnv = () => (env ||= buildEnv());

  function compile(source, key) {
    const e = getEnv();
    if (key && e.cache.has(key)) return e.cache.get(key);
    const fn = e.hb.compile(source, e.opts);
    if (key) e.cache.set(key, fn);
    return fn;
  }

  function run(fn, ctx, label) {
    try {
      const out = fn(ctx, { allowProtoPropertiesByDefault: false, allowProtoMethodsByDefault: false });
      if (out.length > MAX_OUTPUT) throw new Error('el HTML generado supera 2 MB');
      return out;
    } catch (err) {
      const msg = err instanceof RangeError ? 'recursión infinita (¿un partial se incluye a sí mismo?)' : err.message;
      throw new HttpError(422, 'template_error', `Error en ${label}: ${msg.split('\n')[0]}`);
    }
  }

  function rootContext(context, { subject, preheader, iconMode }) {
    const brand = store.getBranding();
    return {
      ...context,
      brand,
      subject,
      preheader: preheader ?? context.preheader ?? '',
      now: new Date().toISOString(),
      // Compatibilidad con plantillas antiguas.
      MAIL_FROM_NAME: legacy.fromName ?? brand.name,
      MAIL_FROM_EMAIL: legacy.fromEmail ?? brand.supportEmail,
      _icons: new Map(),
      _iconMode: iconMode || defaultIconMode,
      _iconBaseUrl: icons.publicUrl,
    };
  }

  // Renderiza una definición de plantilla (guardada o borrador).
  function renderDefinition(def, context = {}, { subject, preheader, cacheKey, iconMode } = {}) {
    const ctx = rootContext(context, { subject, preheader, iconMode });
    if (!subject) {
      const subjectSrc = def.subject || ctx.title || ctx.brand.name;
      // El asunto es texto plano: se deshace el escapado HTML de Handlebars.
      ctx.subject = decode(run(compile(subjectSrc, cacheKey && `${cacheKey}:subject`), ctx, 'el asunto'))
        .replace(/[\r\n\t]+/g, ' ').trim().slice(0, 300);
    }
    const body = run(compile(def.html, cacheKey), ctx, 'la plantilla');

    let html = body;
    const layoutName = def.layout ?? 'base';
    if (def.kind === 'email' && layoutName !== 'none') {
      const layout = store.view('layout', layoutName);
      if (!layout) throw new HttpError(422, 'template_error', `El layout "${layoutName}" no existe`);
      const lfn = compile(layout.html, `layout:${layoutName}:${layout.version}`);
      html = run(lfn, { ...ctx, body }, `el layout "${layoutName}"`);
    }
    return { subject: ctx.subject, html, text: htmlToText(html), attachments: inlineIcons(ctx) };
  }

  // Íconos usados en modo cid → adjuntos inline (multipart/related).
  function inlineIcons(ctx) {
    return [...ctx._icons].map(([cid, i]) => ({
      filename: `${i.name}.png`,
      content: iconPng(i.name, i.color, i.size),
      contentType: 'image/png',
      cid,
      contentDisposition: 'inline',
    }));
  }

  function render(name, context = {}, opts = {}) {
    const def = store.view('email', name);
    if (!def) throw new HttpError(404, 'template_not_found', `Template not found: ${name}`);
    return renderDefinition(def, context, { ...opts, cacheKey: `email:${name}:${def.version}` });
  }

  // Valida una plantilla nueva antes de guardarla: sintaxis, helpers y render de prueba.
  function validate({ kind, html, layout, subject, sampleData, context }) {
    const iconMode = 'data';
    const e = getEnv();
    let fn;
    try {
      fn = e.hb.compile(html, e.opts);
      fn({}, { allowProtoPropertiesByDefault: false }); // fuerza la compilación real
    } catch (err) {
      // Los errores de datos faltantes se detectan luego con sampleData; aquí solo sintaxis/helpers.
      if (/Parse error|unknown helper|not a known helper|Expecting/i.test(err.message)) {
        throw new HttpError(422, 'template_syntax_error', err.message.split('\n').slice(0, 4).join(' '));
      }
    }
    const data = { ...(sampleData || {}), ...(context || {}) };
    if (kind === 'email') return renderDefinition({ kind, html, layout, subject }, data, { iconMode });
    if (kind === 'layout') {
      const ctx = rootContext(data, { subject: subject || 'Vista previa', iconMode });
      const out = run(fn, { ...ctx, body: '<p>Contenido de ejemplo</p>' }, 'el layout');
      return { subject: ctx.subject, html: out, text: htmlToText(out) };
    }
    const ctx = rootContext(data, { subject: 'Vista previa', iconMode });
    const out = run(fn, ctx, 'el partial');
    return { subject: ctx.subject, html: out, text: htmlToText(out) };
  }

  return { render, renderDefinition, validate };
}

const decode = (s) => String(s)
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#x3D;/g, '=').replace(/&#x60;/g, '`');
