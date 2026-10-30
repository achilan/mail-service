// Los endpoints originales deben responder exactamente igual que antes.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startTestServer } from './helpers.js';

const PDF = Buffer.from('%PDF-1.4\n%test').toString('base64');

describe('endpoints heredados', () => {
  let t;
  before(async () => { t = await startTestServer(); });
  after(() => t.close());

  test('GET /health', async () => {
    const r = await t.request('GET', '/health');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, service: 'mail-service' });
  });

  test('sin API key → 401 { error: "Unauthorized" }', async () => {
    const r = await t.request('POST', '/send', { body: { to: 'a@b.com', subject: 'x' } });
    assert.equal(r.status, 401);
    assert.equal(r.json.error, 'Unauthorized');
  });

  test('API key incorrecta → 401', async () => {
    const r = await t.request('POST', '/send', { key: 'nope-nope-nope', body: { to: 'a@b.com', subject: 'x' } });
    assert.equal(r.status, 401);
  });

  test('POST /send → { ok, id } y HTML con la plantilla', async () => {
    const r = await t.request('POST', '/send', {
      key: 'legacy',
      body: { to: 'destino@correo.com', subject: 'Hola', template: 'generic', context: { title: 'Bienvenido', message: 'Gracias por registrarte' } },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.match(r.json.id, /^<.+>$/);
    const sent = t.mailer.sent.at(-1);
    assert.equal(sent.subject, 'Hola');
    assert.match(sent.html, /Bienvenido/);
    assert.match(sent.text, /Gracias por registrarte/);
  });

  test('POST /send acepta "Nombre <email>" y listas separadas por coma', async () => {
    const r = await t.request('POST', '/send', { key: 'legacy', body: { to: 'Juan <a@b.com>, c@d.co', subject: 'x' } });
    assert.equal(r.status, 200);
  });

  test('POST /send con destinatario inválido → 400 Invalid recipient', async () => {
    const r = await t.request('POST', '/send', { key: 'legacy', body: { to: 'nope', subject: 'x' } });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'Invalid recipient');
  });

  test('POST /send sin asunto → 400 { error: "Subject required" }', async () => {
    const r = await t.request('POST', '/send', { key: 'legacy', body: { to: 'a@b.com' } });
    assert.equal(r.status, 400);
    assert.deepEqual(r.json, { error: 'Subject required' });
  });

  test('POST /send bloquea path traversal en el nombre de plantilla', async () => {
    const r = await t.request('POST', '/send', { key: 'legacy', body: { to: 'a@b.com', subject: 'x', template: '../../../etc/passwd' } });
    assert.equal(r.status, 400);
  });

  test('inyección de cabeceras en el asunto se neutraliza', async () => {
    const r = await t.request('POST', '/send', { key: 'legacy', body: { to: 'a@b.com', subject: 'Hola\r\nBcc: victima@x.com' } });
    assert.equal(r.status, 200);
    const sent = t.mailer.sent.at(-1);
    assert.equal(sent.subject, 'Hola Bcc: victima@x.com');
    assert.ok(!sent.bcc);
  });

  test('XSS en message se sanitiza y javascript: en ctaUrl se neutraliza', async () => {
    await t.request('POST', '/notify/generic', {
      key: 'legacy',
      body: { to: 'a@b.com', subject: 'x', message: '<p onclick="x()">ok</p><script>alert(1)</script><img src=x onerror=alert(1)>', ctaUrl: 'javascript:alert(1)', ctaText: 'Clic' },
    });
    const { html } = t.mailer.sent.at(-1);
    assert.doesNotMatch(html, /<script/i);
    assert.doesNotMatch(html, /onclick|onerror/i);
    assert.doesNotMatch(html, /javascript:/i);
    assert.match(html, /<p>ok<\/p>/);
  });

  test('POST /notify/login-success usa el asunto original', async () => {
    const r = await t.request('POST', '/notify/login-success', { key: 'legacy', body: { to: 'a@b.com', userName: 'Anthony' } });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(t.mailer.sent.at(-1).subject, 'Inicio de sesión exitoso');
    assert.match(t.mailer.sent.at(-1).html, /Anthony/);
  });

  test('POST /notify/new-order', async () => {
    const r = await t.request('POST', '/notify/new-order', {
      key: 'legacy',
      body: { to: 'a@b.com', orderId: 'A-001', orderTotal: 123.45, items: [{ name: 'Producto', qty: 2, price: 10 }] },
    });
    assert.equal(r.status, 200);
    const sent = t.mailer.sent.at(-1);
    assert.equal(sent.subject, 'Nueva orden #A-001');
    assert.match(sent.html, /Producto/);
  });

  test('POST /notify/custom', async () => {
    const r = await t.request('POST', '/notify/custom', { key: 'legacy', body: { to: 'a@b.com', title: 'Aviso', message: 'Hecho', ctaUrl: 'https://x.com', ctaText: 'Ver' } });
    assert.equal(r.status, 200);
    assert.equal(t.mailer.sent.at(-1).subject, 'Aviso');
  });

  test('POST /send-html → mismos mensajes de error', async () => {
    let r = await t.request('POST', '/send-html', { key: 'legacy', body: { to: 'a@b.com', subject: 'x' } });
    assert.deepEqual(r.json, { error: 'HTML content required' });
    r = await t.request('POST', '/send-html', { key: 'legacy', body: { to: 'a@b.com', subject: 'x', html: '<b>Hola</b>' } });
    assert.equal(r.status, 200);
    assert.equal(t.mailer.sent.at(-1).text, 'Hola');
  });

  test('POST /send-html requiere el permiso mail:send:raw', async () => {
    const r = await t.request('POST', '/send-html', { key: 'sender', body: { to: 'a@b.com', subject: 'x', html: '<b>x</b>' } });
    assert.equal(r.status, 403);
  });

  test('POST /documents/send → 202, procesa y adjunta PDF + XML', async () => {
    const r = await t.request('POST', '/documents/send', {
      key: 'legacy',
      body: {
        to: 'cliente@correo.com', cc: ['copia@correo.com'], destinatarioNombre: 'Juan Pérez', tipoDocumento: 'Nota de Crédito',
        documento: { numero: '001-001-000000123', razonSocialEmisor: 'Mi Empresa S.A.', total: '123.45', claveAcceso: '0606' },
        adjuntos: { pdfBase64: PDF, xmlBase64: Buffer.from('<x/>').toString('base64') },
      },
    });
    assert.equal(r.status, 202);
    assert.deepEqual(Object.keys(r.json).sort(), ['jobId', 'ok', 'status']);
    const job = await t.waitForJob(r.json.jobId);
    assert.equal(job.status, 'sent');
    const sent = t.mailer.sent.at(-1);
    assert.equal(sent.subject, 'Nota de Crédito 001-001-000000123 - Mi Empresa S.A.');
    const files = sent.attachments.filter((a) => !a.cid);
    assert.deepEqual(files.map((a) => a.filename), ['001-001-000000123.pdf', '001-001-000000123.xml']);
    // Los íconos viajan como imágenes inline (cid) referenciadas desde el HTML.
    for (const a of sent.attachments.filter((x) => x.cid)) assert.ok(sent.html.includes(`cid:${a.cid}`));
  });

  test('POST /documents/send tipo general', async () => {
    const r = await t.request('POST', '/documents/send', {
      key: 'legacy',
      body: { to: 'a@b.com', tipoDocumento: 'general', title: 'Reporte anual', body: '<p>Adjunto</p>', adjuntos: { pdfBase64: PDF } },
    });
    const job = await t.waitForJob(r.json.jobId);
    assert.equal(job.status, 'sent');
    assert.deepEqual(t.mailer.sent.at(-1).attachments.filter((a) => !a.cid).map((a) => a.filename), ['Reporte anual.pdf']);
  });

  test('POST /documents/send con tipo inválido → mismo error y lista de válidos', async () => {
    const r = await t.request('POST', '/documents/send', { key: 'legacy', body: { to: 'a@b.com', tipoDocumento: 'zzz', adjuntos: { pdfBase64: PDF } } });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'tipoDocumento inválido');
    assert.ok(r.json.validos.includes('factura'));
  });

  test('POST /documents/send sin PDF → 400', async () => {
    const r = await t.request('POST', '/documents/send', { key: 'legacy', body: { to: 'a@b.com', tipoDocumento: 'factura' } });
    assert.deepEqual(r.json, { error: 'Se requiere adjuntos.pdfBase64 o adjuntos.pdfUrl' });
  });

  test('POST /documents/send con URL interna (SSRF) → el job falla sin reintentos', async () => {
    const r = await t.request('POST', '/documents/send', { key: 'legacy', body: { to: 'a@b.com', tipoDocumento: 'factura', adjuntos: { pdfUrl: 'http://169.254.169.254/latest/meta-data' } } });
    const job = await t.waitForJob(r.json.jobId);
    assert.equal(job.status, 'failed');
    assert.equal(job.attempts, 1);
  });

  test('Idempotency-Key evita envíos duplicados', async () => {
    const body = { to: 'a@b.com', tipoDocumento: 'factura', adjuntos: { pdfBase64: PDF } };
    const a = await t.request('POST', '/documents/send', { key: 'legacy', body, headers: { 'Idempotency-Key': 'fact-123' } });
    const b = await t.request('POST', '/documents/send', { key: 'legacy', body, headers: { 'Idempotency-Key': 'fact-123' } });
    assert.equal(a.json.jobId, b.json.jobId);
  });

  test('un job solo es visible para la llave que lo creó', async () => {
    const r = await t.request('POST', '/documents/send', { key: 'sender', body: { to: 'a@b.com', tipoDocumento: 'factura', adjuntos: { pdfBase64: PDF } } });
    const other = await t.request('GET', `/jobs/${r.json.jobId}`, { key: 'sender2' });
    assert.equal(other.status, 404);
    assert.deepEqual(other.json, { error: 'Job no encontrado o expirado' });
    const own = await t.request('GET', `/jobs/${r.json.jobId}`, { key: 'sender' });
    assert.equal(own.status, 200);
  });

  test('GET /queue/stats', async () => {
    const r = await t.request('GET', '/queue/stats', { key: 'legacy' });
    assert.equal(r.json.ok, true);
    for (const k of ['pending', 'active', 'total']) assert.equal(typeof r.json[k], 'number');
  });

  test('GET /preview/:template sigue disponible y cae a generic si no existe', async () => {
    let r = await t.request('GET', '/preview/new-order');
    assert.equal(r.status, 200);
    assert.match(r.text, /Resumen del pedido/);
    r = await t.request('GET', '/preview/no-existe');
    assert.equal(r.status, 200);
  });

  test('cabeceras de seguridad presentes', async () => {
    const r = await t.request('GET', '/health');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-powered-by'), null);
    assert.ok(r.headers.get('x-request-id'));
  });

  test('JSON inválido → 400 sin stack', async () => {
    const r = await t.request('POST', '/send', { key: 'legacy', body: '{nope', headers: { 'content-type': 'application/json' } });
    assert.equal(r.status, 400);
    assert.doesNotMatch(r.text, /at .*\.js/);
  });
});
