import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { checkConfig, loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { isPrivateAddress, safeFetch, validateAttachmentUrl } from '../src/security/ssrf.js';
import { safeUrl, sanitizeMessage } from '../src/security/sanitize.js';
import { parseRecipients } from '../src/validation.js';
import { safeFilename } from '../src/mail/attachments.js';
import { startTestServer } from './helpers.js';

describe('SSRF', () => {
  test('detecta direcciones privadas, loopback y metadata', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1']) {
      assert.equal(isPrivateAddress(ip), true, ip);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);
  });

  test('rechaza URLs peligrosas', () => {
    for (const url of ['file:///etc/passwd', 'ftp://x.com/a', 'http://localhost/x', 'https://user:pass@x.com/', 'http://127.0.0.1/', 'http://[::1]/', 'gopher://x']) {
      assert.throws(() => validateAttachmentUrl(url, { allowHttp: true }), url);
    }
    assert.throws(() => validateAttachmentUrl('http://x.com/a.pdf', { allowHttp: false }));
  });

  test('allowlist de hosts', () => {
    assert.throws(() => validateAttachmentUrl('https://evil.com/a.pdf', { urlAllowlist: ['cdn.miempresa.com'] }));
    assert.ok(validateAttachmentUrl('https://files.cdn.miempresa.com/a.pdf', { urlAllowlist: ['cdn.miempresa.com'] }));
  });

  test('hosts de confianza explícitos pueden ser internos', () => {
    assert.ok(validateAttachmentUrl('http://127.0.0.1/a.pdf', { allowHttp: true, trustedHosts: ['127.0.0.1'] }));
  });

  test('bloquea en conexión un dominio que resuelve a loopback', async () => {
    await assert.rejects(safeFetch('http://localtest.me/x', { allowHttp: true, timeoutMs: 2000 }), /bloquead|ENOTFOUND|EAI_AGAIN/i);
  });
});

describe('sanitización', () => {
  test('mantiene formato y elimina lo peligroso', () => {
    const out = sanitizeMessage('<p style="color:#f00;position:fixed">Hola <a href="javascript:x">a</a> <a href="https://ok.com">b</a></p><style>*{}</style><svg onload=x>');
    assert.match(out, /<p style="color:#f00">/);
    assert.doesNotMatch(out, /javascript|onload|<style|<svg|position/);
    assert.match(out, /href="https:\/\/ok\.com"/);
  });

  test('texto plano: escapa y convierte saltos de línea', () => {
    assert.equal(sanitizeMessage('a < b\n\nlinea'), '<p>a &lt; b</p><p>linea</p>');
  });

  test('safeUrl', () => {
    assert.equal(safeUrl('javascript:alert(1)'), '#');
    assert.equal(safeUrl(' JaVaScRiPt:alert(1)'), '#');
    assert.equal(safeUrl('data:text/html,x'), '#');
    assert.equal(safeUrl('https://x.com'), 'https://x.com');
    assert.equal(safeUrl('mailto:a@b.com'), 'mailto:a@b.com');
  });

  test('nombres de archivo seguros', () => {
    assert.equal(safeFilename('../../etc/passwd'), 'passwd');
    assert.equal(safeFilename('..\\..\\x.pdf').includes('/'), false);
    assert.equal(safeFilename(''), 'adjunto');
  });

  test('destinatarios', () => {
    assert.deepEqual(parseRecipients('a@b.com'), ['a@b.com']);
    assert.equal(parseRecipients('a@b.com\r\nBcc: x@y.com'), null);
    assert.equal(parseRecipients('no-es-email'), null);
    assert.equal(parseRecipients({ $ne: 1 }), null);
  });
});

describe('configuración', () => {
  test('no arranca sin API keys', () => {
    const { errors } = checkConfig(loadConfig({ MAIL_TRANSPORT: 'json' }));
    assert.ok(errors.length > 0);
  });

  test('ALLOW_INSECURE_NO_AUTH se ignora en producción', () => {
    const cfg = loadConfig({ NODE_ENV: 'production', ALLOW_INSECURE_NO_AUTH: 'true', MAIL_TRANSPORT: 'json' });
    assert.equal(cfg.auth.allowNoAuth, false);
    assert.ok(checkConfig(cfg).errors.length > 0);
  });

  test('advierte llaves cortas', () => {
    const { warnings } = checkConfig(loadConfig({ API_KEY: 'corta', MAIL_TRANSPORT: 'json' }));
    assert.ok(warnings.some((w) => /corta/.test(w)));
  });

  test('el logger redacta secretos', () => {
    const lines = [];
    const orig = process.stdout.write;
    process.stdout.write = (s) => { lines.push(s); return true; };
    try {
      createLogger({ level: 'debug' }).info('x', { headers: { 'x-api-key': 'secret', authorization: 'Bearer y' }, pdfBase64: 'AAAA', ok: 1 });
    } finally {
      process.stdout.write = orig;
    }
    assert.doesNotMatch(lines.join(''), /secret|Bearer y|AAAA/);
  });
});

describe('rate limiting', () => {
  test('bloquea fuerza bruta de API keys', async () => {
    const t = await startTestServer({ RATE_LIMIT_AUTH_FAIL_MAX: '3' });
    try {
      const codes = [];
      for (let i = 0; i < 5; i++) codes.push((await t.request('GET', '/queue/stats', { key: `bad-${i}` })).status);
      assert.deepEqual(codes, [401, 401, 401, 429, 429]);
    } finally {
      await t.close();
    }
  });

  test('límite de envíos por llave', async () => {
    const t = await startTestServer({ RATE_LIMIT_SEND_MAX: '2' });
    try {
      const codes = [];
      for (let i = 0; i < 3; i++) codes.push((await t.request('POST', '/send', { key: 'legacy', body: { to: 'a@b.com', subject: 'x' } })).status);
      assert.deepEqual(codes, [200, 200, 429]);
    } finally {
      await t.close();
    }
  });
});
