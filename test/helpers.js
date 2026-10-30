import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { createMailer } from '../src/mail/mailer.js';
import { createQueue } from '../src/queue.js';
import { createEngine, loadBuiltins } from '../src/templates/engine.js';
import { createStore } from '../src/templates/store.js';

export const KEYS = {
  admin: 'admin-key-0123456789abcdefghijklmnopqrstuv',
  sender: 'sender-key-0123456789abcdefghijklmnopqrstuv',
  sender2: 'sender2-key-0123456789abcdefghijklmnopqrstu',
  editor: 'editor-key-0123456789abcdefghijklmnopqrstuv',
  legacy: 'legacy-key-0123456789abcdefghijklmnopqrstuv',
};

// Levanta la app real (transporte json: no envía nada) en un puerto efímero.
export async function startTestServer(envOverrides = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mail-service-test-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    MAIL_TRANSPORT: 'json',
    MAIL_FROM_NAME: 'Test Service',
    MAIL_FROM_EMAIL: 'no-reply@test.dev',
    DATA_DIR: dataDir,
    API_KEY: KEYS.legacy,
    API_KEYS: [
      `admin:${KEYS.admin}:admin`,
      `sender:${KEYS.sender}:mail:send`,
      `sender2:${KEYS.sender2}:mail:send`,
      `editor:${KEYS.editor}:templates:write`,
    ].join(','),
    QUEUE_RETRY_BASE_MS: '10',
    ...envOverrides,
  });
  const logger = createLogger({ silent: true });
  const builtins = await loadBuiltins(config.templatesDir);
  const store = await createStore({ dataDir, builtins, defaultBrand: config.brand });
  const engine = createEngine({ store, icons: config.icons, legacy: { fromName: config.mail.fromName, fromEmail: config.mail.fromEmail } });
  const mailer = createMailer(config, logger);
  const queue = createQueue(config.queue, logger);
  const app = createApp({ config, logger, mailer, queue, store, engine });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  async function request(method, url, { key, body, headers = {} } = {}) {
    const res = await fetch(base + url, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(key ? { 'x-api-key': KEYS[key] ?? key } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: res.status, headers: res.headers, json, text };
  }

  async function waitForJob(id, key = 'legacy') {
    for (let i = 0; i < 100; i++) {
      const r = await request('GET', `/jobs/${id}`, { key });
      if (r.json?.status === 'sent' || r.json?.status === 'failed') return r.json;
      await new Promise((res) => setTimeout(res, 20));
    }
    throw new Error('job no terminó');
  }

  async function close() {
    await queue.stop({ timeoutMs: 1000 });
    await new Promise((r) => server.close(r));
    await store.flush();
    await fs.rm(dataDir, { recursive: true, force: true });
  }

  return { base, request, waitForJob, close, mailer, store, engine, queue, config };
}
