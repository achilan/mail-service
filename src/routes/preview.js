// Vistas previas en el navegador con datos de ejemplo (sin autenticación,
// por compatibilidad con /preview/:template). Desactivable con ENABLE_PREVIEW=false.
// Nunca muestran datos reales: solo el sampleData de cada plantilla.

import { Router } from 'express';
import { TEMPLATE_NAME } from '../validation.js';
import { sendHtmlPreview } from './v1.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function gallery(templates, brand) {
  const cards = templates.map((t) => `
    <article class="card">
      <div class="frame"><iframe src="/preview/${esc(t.name)}" title="${esc(t.name)}" loading="lazy" sandbox="allow-same-origin"></iframe></div>
      <div class="meta">
        <div class="row"><h2>${esc(t.name)}</h2><span class="pill ${t.source}">${t.source === 'custom' ? `v${t.version} · personalizada` : 'incluida'}</span></div>
        <p>${esc(t.description || '')}</p>
        <a href="/preview/${esc(t.name)}" target="_blank" rel="noopener">Abrir en pantalla completa →</a>
      </div>
    </article>`).join('');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Plantillas · ${esc(brand.name)}</title>
<style>
  :root{--bg:#F2F4F7;--card:#fff;--text:#101828;--muted:#667085;--border:#EAECF0;--brand:${esc(brand.primaryColor)}}
  @media (prefers-color-scheme:dark){:root{--bg:#0C0E12;--card:#161B26;--text:#F5F5F6;--muted:#94969C;--border:#1F242F}}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
  header{max-width:1280px;margin:0 auto;padding:40px 16px 8px}h1{margin:0 0 4px;font-size:28px;letter-spacing:-.02em}header p{margin:0;color:var(--muted)}
  header a{color:var(--brand);font-weight:600;text-decoration:none}
  main{max-width:1280px;margin:0 auto;padding:24px 16px 64px;display:grid;gap:24px;grid-template-columns:repeat(auto-fill,minmax(min(100%,380px),1fr))}
  .card{background:var(--card);border:1px solid var(--border);border-radius:20px;overflow:hidden;box-shadow:0 12px 32px -16px rgba(16,24,40,.18)}
  .frame{height:520px;overflow:hidden;border-bottom:1px solid var(--border);background:#F2F4F7}
  iframe{width:200%;height:1040px;border:0;transform:scale(.5);transform-origin:0 0;pointer-events:none}
  .meta{padding:16px 20px 20px}.row{display:flex;align-items:center;justify-content:space-between;gap:8px}
  h2{margin:0;font-size:16px;font-family:'SF Mono',Menlo,monospace}.meta p{margin:6px 0 12px;color:var(--muted);font-size:14px}
  .meta a{color:var(--brand);font-weight:600;text-decoration:none;font-size:14px}
  .pill{font-size:12px;font-weight:600;padding:3px 10px;border-radius:999px;background:var(--bg);color:var(--muted);white-space:nowrap}.pill.custom{background:var(--brand);color:#fff}
</style></head><body>
<header><h1>Plantillas de correo</h1><p>${templates.length} plantillas con datos de ejemplo · <a href="/docs">Documentación de la API</a></p></header>
<main>${cards}</main></body></html>`;
}

export function previewRouter({ store, engine }) {
  const router = Router();

  router.get('/preview', (req, res) => {
    const html = gallery(store.list('email'), store.getBranding());
    res
      .set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-src 'self'; img-src 'self' https: data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
      .type('html')
      .send(html);
  });

  router.get('/preview/:template', (req, res) => {
    const { template } = req.params;
    // Igual que antes: plantilla desconocida → se usa la genérica.
    const name = TEMPLATE_NAME.test(template) && store.view('email', template) ? template : 'generic';
    const t = store.view('email', name);
    const out = engine.render(name, t.sampleData, { iconMode: 'data' });
    sendHtmlPreview(res, out.html);
  });

  return router;
}
