import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startTestServer } from './helpers.js';

const HERO = "{{> hero icon='analytics' tone='success' title=title}}<div class=\"em-content\">{{{safe message}}}</div>{{> signature}}";

describe('API v1 — envío', () => {
  let t;
  before(async () => { t = await startTestServer(); });
  after(() => t.close());

  test('POST /v1/emails encola, envía y usa el asunto por defecto de la plantilla', async () => {
    const r = await t.request('POST', '/v1/emails', {
      key: 'sender',
      body: { to: ['a@b.com'], template: 'otp-code', context: { code: '482913' }, tags: ['otp'] },
    });
    assert.equal(r.status, 202);
    const job = await t.waitForJob(r.json.jobId, 'sender');
    assert.equal(job.status, 'sent');
    const sent = t.mailer.sent.at(-1);
    assert.equal(sent.subject, '482913 es tu código de verificación');
    assert.match(sent.html, /482913/);
    assert.equal(sent.headers['X-Mail-Tags'], 'otp');
  });

  test('valida antes de encolar: plantilla inexistente → 404', async () => {
    const r = await t.request('POST', '/v1/emails', { key: 'sender', body: { to: 'a@b.com', template: 'nope' } });
    assert.equal(r.status, 404);
  });

  test('rechaza adjuntos ejecutables', async () => {
    const r = await t.request('POST', '/v1/emails', {
      key: 'sender',
      body: { to: 'a@b.com', attachments: [{ filename: 'virus.exe', contentBase64: 'TVo=' }] },
    });
    const job = await t.waitForJob(r.json.jobId, 'sender');
    assert.equal(job.status, 'failed');
    assert.match(job.error, /no permitido/);
  });

  test('cabeceras personalizadas solo X-*', async () => {
    const r = await t.request('POST', '/v1/emails', { key: 'sender', body: { to: 'a@b.com', headers: { Bcc: 'x@y.com' } } });
    assert.equal(r.status, 400);
    assert.equal(r.json.code, 'validation_error');
  });

  test('batch es todo o nada', async () => {
    const r = await t.request('POST', '/v1/emails/batch', {
      key: 'sender',
      body: { messages: [{ to: 'a@b.com' }, { to: 'mal' }] },
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /messages\[1\]/);
    const ok = await t.request('POST', '/v1/emails/batch', { key: 'sender', body: { messages: [{ to: 'a@b.com' }, { to: 'c@d.com' }] } });
    assert.equal(ok.status, 202);
    assert.equal(ok.json.count, 2);
  });

  test('render sin enviar', async () => {
    const r = await t.request('POST', '/v1/emails/render', { key: 'sender', body: { template: 'welcome', context: { userName: 'Ana' } } });
    assert.equal(r.status, 200);
    assert.match(r.json.subject, /bienvenida/i);
    assert.match(r.json.text, /Ana/);
  });

  test('límite de destinatarios', async () => {
    const to = Array.from({ length: 51 }, (_, i) => `u${i}@b.com`);
    const r = await t.request('POST', '/v1/emails', { key: 'sender', body: { to } });
    assert.equal(r.status, 400);
  });
});

describe('API v1 — plantillas', () => {
  let t;
  before(async () => { t = await startTestServer(); });
  after(() => t.close());

  test('listar incluye las 9 plantillas incluidas', async () => {
    const r = await t.request('GET', '/v1/templates', { key: 'editor' });
    assert.equal(r.status, 200);
    const names = r.json.items.map((i) => i.name);
    for (const n of ['generic', 'notification', 'login-success', 'new-order', 'document', 'welcome', 'password-reset', 'otp-code', 'event-ticket']) {
      assert.ok(names.includes(n), n);
    }
  });

  test('una llave de solo envío no puede editar', async () => {
    const r = await t.request('PUT', '/v1/templates/reporte', { key: 'sender', body: { html: HERO } });
    assert.equal(r.status, 403);
  });

  test('crear → leer → editar con If-Match → historial → rollback → borrar', async () => {
    let r = await t.request('PUT', '/v1/templates/reporte', {
      key: 'editor',
      body: { html: HERO, subject: 'Reporte de {{title}}', sampleData: { title: 'Octubre', message: 'Listo' } },
    });
    assert.equal(r.status, 201);
    assert.equal(r.json.version, 1);
    assert.equal(r.headers.get('etag'), '"1"');

    r = await t.request('GET', '/v1/templates/reporte', { key: 'editor' });
    assert.equal(r.json.source, 'custom');

    // Conflicto: alguien más ya guardó la v1.
    r = await t.request('PATCH', '/v1/templates/reporte', { key: 'editor', body: { description: 'x' }, headers: { 'If-Match': '"0"' } });
    assert.equal(r.status, 409);

    r = await t.request('PATCH', '/v1/templates/reporte', { key: 'editor', body: { subject: 'Nuevo {{title}}' }, headers: { 'If-Match': '"1"' } });
    assert.equal(r.status, 200);
    assert.equal(r.json.version, 2);
    assert.equal(r.json.html, HERO); // PATCH conserva el resto

    r = await t.request('GET', '/v1/templates/reporte/versions', { key: 'editor' });
    assert.deepEqual(r.json.versions.map((v) => v.version), [2, 1]);

    r = await t.request('POST', '/v1/templates/reporte/rollback', { key: 'editor', body: { version: 1 } });
    assert.equal(r.json.version, 3);
    assert.equal(r.json.subject, 'Reporte de {{title}}');

    // La plantilla nueva se puede usar para enviar.
    const send = await t.request('POST', '/send', { key: 'legacy', body: { to: 'a@b.com', subject: 'x', template: 'reporte', context: { title: 'Nov', message: 'Hola' } } });
    assert.equal(send.status, 200);

    r = await t.request('DELETE', '/v1/templates/reporte', { key: 'editor' });
    assert.equal(r.json.restoredBuiltin, false);
    r = await t.request('GET', '/v1/templates/reporte', { key: 'editor' });
    assert.equal(r.status, 404);
  });

  test('sobrescribir una plantilla incluida y restaurarla', async () => {
    let r = await t.request('PATCH', '/v1/templates/notification', { key: 'editor', body: { subject: 'Aviso: {{title}}' } });
    assert.equal(r.json.source, 'custom');
    r = await t.request('POST', '/v1/templates/notification/preview', { key: 'editor', body: { context: { title: 'Hola' } } });
    assert.equal(r.json.subject, 'Aviso: Hola');
    r = await t.request('DELETE', '/v1/templates/notification', { key: 'editor' });
    assert.equal(r.json.restoredBuiltin, true);
    r = await t.request('GET', '/v1/templates/notification', { key: 'editor' });
    assert.equal(r.json.source, 'builtin');
  });

  test('rechaza <script>, handlers on* y javascript:', async () => {
    for (const html of ['<script>alert(1)</script>', '<a href="#" onclick="x()">x</a>', '<a href="javascript:alert(1)">x</a>', '<iframe src="https://x"></iframe>']) {
      const r = await t.request('PUT', '/v1/templates/malo', { key: 'editor', body: { html } });
      assert.equal(r.status, 422, html);
    }
  });

  test('rechaza helpers desconocidos y sintaxis inválida', async () => {
    let r = await t.request('PUT', '/v1/templates/malo', { key: 'editor', body: { html: '{{#if}}' } });
    assert.equal(r.status, 422);
    r = await t.request('PUT', '/v1/templates/malo', { key: 'editor', body: { html: '{{exec "rm -rf /"}}' } });
    assert.equal(r.status, 422);
  });

  test('no permite acceder a prototipos desde la plantilla', async () => {
    const r = await t.request('POST', '/v1/templates/validate', {
      key: 'editor',
      body: { html: '{{constructor.constructor}}|{{__proto__}}|{{lookup this "constructor"}}', layout: 'none' },
    });
    assert.equal(r.status, 200);
    assert.doesNotMatch(r.json.preview.html, /function|native code|Object/);
  });

  test('nombre inválido → 400', async () => {
    const r = await t.request('PUT', '/v1/templates/..%2F..%2Fetc', { key: 'editor', body: { html: 'x' } });
    assert.equal(r.status, 400);
  });

  test('partials personalizados están disponibles en las plantillas', async () => {
    let r = await t.request('PUT', '/v1/partials/promo', { key: 'editor', body: { html: '<p class="promo">Usa el código {{code}}</p>' } });
    assert.equal(r.status, 201);
    r = await t.request('POST', '/v1/templates/validate', { key: 'editor', body: { html: "{{> promo code='OFF20'}}" } });
    assert.match(r.json.preview.html, /Usa el código OFF20/);
  });

  test('partial recursivo no tumba el servidor', async () => {
    await t.request('PUT', '/v1/partials/loop', { key: 'editor', body: { html: '<b>x</b>' } });
    // Guardar un partial que se incluye a sí mismo debe fallar en la validación.
    const r = await t.request('PUT', '/v1/partials/loop', { key: 'editor', body: { html: '{{> loop}}' } });
    assert.ok([200, 422].includes(r.status));
    const health = await t.request('GET', '/health');
    assert.equal(health.status, 200);
  });

  test('layouts: crear uno mínimo y usarlo', async () => {
    let r = await t.request('PUT', '/v1/layouts/minimal', { key: 'editor', body: { html: '<html><body><main>{{{body}}}</main></body></html>' } });
    assert.equal(r.status, 201);
    r = await t.request('PUT', '/v1/templates/simple', { key: 'editor', body: { html: '<p>Hola {{name}}</p>', layout: 'minimal', sampleData: { name: 'Ana' } } });
    assert.equal(r.status, 201);
    r = await t.request('POST', '/v1/templates/simple/preview', { key: 'editor', body: {} });
    assert.equal(r.json.html, '<html><body><main><p>Hola Ana</p></main></body></html>');
    r = await t.request('DELETE', '/v1/layouts/base', { key: 'editor' });
    assert.equal(r.status, 409);
  });

  test('preview en HTML con CSP restrictiva', async () => {
    const r = await t.request('POST', '/v1/templates/welcome/preview', { key: 'editor', body: { format: 'html' } });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
    assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
  });
});

describe('API v1 — branding y auditoría', () => {
  let t;
  before(async () => { t = await startTestServer(); });
  after(() => t.close());

  test('solo admin cambia el branding y se refleja en los correos', async () => {
    let r = await t.request('PUT', '/v1/branding', { key: 'editor', body: { name: 'X' } });
    assert.equal(r.status, 403);
    r = await t.request('PUT', '/v1/branding', { key: 'admin', body: { name: 'Acme', primaryColor: '#0E7490' } });
    assert.equal(r.status, 200);
    r = await t.request('POST', '/v1/emails/render', { key: 'admin', body: { template: 'generic', context: { title: 'Hola' } } });
    assert.match(r.json.html, /Acme/);
    assert.match(r.json.html, /#0E7490/);
  });

  test('branding valida colores y URLs https', async () => {
    let r = await t.request('PUT', '/v1/branding', { key: 'admin', body: { primaryColor: 'red;}</style><script>' } });
    assert.equal(r.status, 400);
    r = await t.request('PUT', '/v1/branding', { key: 'admin', body: { logoUrl: 'javascript:alert(1)' } });
    assert.equal(r.status, 400);
  });

  test('auditoría registra quién cambió qué', async () => {
    await t.request('PUT', '/v1/templates/audit-me', { key: 'editor', body: { html: '<p>x</p>' } });
    const r = await t.request('GET', '/v1/audit', { key: 'admin' });
    const entry = r.json.entries.find((e) => e.name === 'audit-me');
    assert.equal(entry.actor, 'editor');
    assert.equal(entry.action, 'template.create');
  });
});

describe('documentación', () => {
  let t;
  before(async () => { t = await startTestServer(); });
  after(() => t.close());

  test('/openapi.json es OpenAPI 3.1 e incluye rutas heredadas y v1', async () => {
    const r = await t.request('GET', '/openapi.json');
    assert.equal(r.json.openapi, '3.1.0');
    for (const p of ['/send', '/documents/send', '/v1/emails', '/v1/templates/{name}', '/v1/branding']) assert.ok(r.json.paths[p], p);
  });

  test('/docs sirve Swagger UI local con CSP', async () => {
    const r = await t.request('GET', '/docs');
    assert.equal(r.status, 200);
    assert.match(r.text, /swagger-ui-bundle\.js/);
    assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
    const asset = await t.request('GET', '/docs/assets/swagger-ui-bundle.js');
    assert.equal(asset.status, 200);
  });
});
