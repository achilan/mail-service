// API v1: envío de correos, gestión de plantillas/layouts/partials, branding y jobs.

import { Router } from 'express';
import { asyncHandler, HttpError, parse } from '../http.js';
import { hasScope, requireScope, SCOPES } from '../security/auth.js';
import { findForbiddenMarkup } from '../security/sanitize.js';
import { resolveAttachments } from '../mail/attachments.js';
import { KINDS } from '../templates/store.js';
import { CATALOG } from '../templates/catalog.js';
import { iconNames } from '../templates/icon-render.js';
import {
  batchSchema, brandingSchema, checkRecipients, cleanSubject, emailSchema, parseRecipients,
  renderSchema, TEMPLATE_NAME, templatePatchSchema, templateWriteSchema, validateTemplateSchema,
} from '../validation.js';

// /v1/templates → email, /v1/layouts → layout, /v1/partials → partial
const COLLECTIONS = { templates: 'email', layouts: 'layout', partials: 'partial' };

const publicJob = (job) => ({
  jobId: job.id,
  status: job.status,
  attempts: job.attempts,
  result: job.result,
  error: job.error,
  template: job.meta?.template,
  tags: job.meta?.tags,
  createdAt: job.createdAt,
  updatedAt: job.updatedAt,
});

export function v1Router({ config, engine, mailer, queue, store }) {
  const router = Router();
  const read = requireScope(SCOPES.TEMPLATES_READ);
  const write = requireScope(SCOPES.TEMPLATES_WRITE);
  const admin = requireScope(SCOPES.ADMIN);

  // ─────────────────────────────── Envío ───────────────────────────────

  // Valida todo lo posible ANTES de encolar para responder 400 inmediato.
  function prepareEmail(input) {
    const msg = parse(emailSchema, input);
    const recipients = checkRecipients(msg, config.mail);
    if (msg.replyTo && !parseRecipients(msg.replyTo)?.length) {
      throw new HttpError(400, 'invalid_reply_to', 'replyTo inválido');
    }
    if (!store.view('email', msg.template)) {
      throw new HttpError(404, 'template_not_found', `Template not found: ${msg.template}`);
    }
    if (msg.attachments.length > config.attachments.maxCount) {
      throw new HttpError(400, 'too_many_attachments', `Máximo ${config.attachments.maxCount} adjuntos`);
    }
    return { ...msg, ...recipients };
  }

  queue.setHandler('email', async (msg) => {
    const rendered = engine.render(msg.template, msg.context, {
      subject: msg.subject ? cleanSubject(msg.subject) : undefined,
      preheader: msg.preheader,
    });
    const attachments = await resolveAttachments(msg.attachments, config.attachments);
    const headers = { ...(msg.headers || {}) };
    if (msg.tags?.length) headers['X-Mail-Tags'] = msg.tags.join(',');
    return mailer.send({
      to: msg.to, cc: msg.cc, bcc: msg.bcc, replyTo: msg.replyTo,
      subject: rendered.subject, html: rendered.html, text: rendered.text,
      attachments: [...rendered.attachments, ...attachments], headers, unsubscribeUrl: msg.unsubscribeUrl,
    });
  });

  const enqueueEmail = (req, msg, idempotencyKey) => queue.enqueue('email', msg, {
    owner: req.auth.keyId,
    idempotencyKey,
    meta: { template: msg.template, tags: msg.tags },
  });

  router.post('/emails', requireScope(SCOPES.SEND), (req, res) => {
    const msg = prepareEmail(req.body);
    const { job, duplicate } = enqueueEmail(req, msg, req.get('idempotency-key')?.slice(0, 200) || null);
    res.status(duplicate ? 200 : 202).json({ ok: true, duplicate, ...publicJob(job) });
  });

  router.post('/emails/batch', requireScope(SCOPES.SEND), (req, res) => {
    const { messages } = parse(batchSchema, req.body);
    // Se valida el lote completo antes de encolar nada: todo o nada.
    const prepared = messages.map((m, i) => {
      try {
        return prepareEmail(m);
      } catch (err) {
        if (err instanceof HttpError) err.message = `messages[${i}]: ${err.message}`;
        throw err;
      }
    });
    const jobs = prepared.map((m) => publicJob(enqueueEmail(req, m, null).job));
    res.status(202).json({ ok: true, count: jobs.length, jobs });
  });

  // Renderiza sin enviar (útil para depurar integraciones).
  router.post('/emails/render', requireScope(SCOPES.SEND), (req, res) => {
    const msg = parse(emailSchema.omit({ to: true }).extend({ to: emailSchema.shape.to.optional() }), req.body);
    const { attachments, ...out } = engine.render(msg.template, msg.context, { subject: msg.subject, preheader: msg.preheader, iconMode: 'data' });
    res.json({ ok: true, ...out });
  });

  // ─────────────────────────────── Jobs ───────────────────────────────

  const canSee = (req, job) => job && (job.owner === req.auth.keyId || hasScope(req.auth, SCOPES.ADMIN));

  router.get('/jobs', requireScope(SCOPES.SEND), (req, res) => {
    const status = ['queued', 'processing', 'sent', 'failed'].includes(req.query.status) ? req.query.status : undefined;
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const owner = hasScope(req.auth, SCOPES.ADMIN) ? undefined : req.auth.keyId;
    res.json({ ok: true, jobs: queue.listJobs({ owner, status, limit }).map(publicJob) });
  });

  router.get('/jobs/:id', requireScope(SCOPES.SEND), (req, res) => {
    const job = queue.getJob(req.params.id);
    if (!canSee(req, job)) throw new HttpError(404, 'job_not_found', 'Job no encontrado o expirado');
    res.json({ ok: true, ...publicJob(job) });
  });

  // ──────────────────────── Plantillas / layouts / partials ────────────────────────

  function nameParam(req) {
    const { name } = req.params;
    if (!TEMPLATE_NAME.test(name)) throw new HttpError(400, 'invalid_name', 'Nombre inválido: usa a-z, 0-9, "-" o "_" (máx. 64)');
    return name;
  }

  function checkSource(kind, fields) {
    for (const [field, value] of [['html', fields.html], ['subject', fields.subject]]) {
      const problem = value && findForbiddenMarkup(value);
      if (problem) throw new HttpError(422, 'forbidden_markup', `${field}: ${problem}`);
    }
    if (fields.layout && fields.layout !== 'none' && !store.view('layout', fields.layout)) {
      throw new HttpError(422, 'layout_not_found', `El layout "${fields.layout}" no existe`);
    }
    // Compila y renderiza de prueba con los datos de ejemplo: si falla, no se guarda.
    return engine.validate({ kind, ...fields });
  }

  // ETag/If-Match para evitar que dos personas se pisen los cambios.
  function expectedVersion(req) {
    const h = req.get('if-match');
    if (!h) return undefined;
    const v = Number(String(h).replace(/[W/"]/g, ''));
    if (!Number.isInteger(v) || v < 0) throw new HttpError(400, 'invalid_if_match', 'If-Match debe ser el número de versión');
    return v;
  }

  async function saveWithConflict(kind, name, fields, req) {
    try {
      return await store.save(kind, name, fields, { actor: req.auth.keyId, expectedVersion: expectedVersion(req) });
    } catch (err) {
      if (err.code === 'VERSION_CONFLICT') {
        throw new HttpError(409, 'version_conflict', err.message, { currentVersion: err.currentVersion });
      }
      throw err;
    }
  }

  router.post('/templates/validate', write, (req, res) => {
    const input = parse(validateTemplateSchema, req.body);
    const { attachments, ...preview } = checkSource(input.kind, input);
    res.json({ ok: true, valid: true, preview });
  });

  for (const [collection, kind] of Object.entries(COLLECTIONS)) {
    const base = `/${collection}`;

    router.get(base, read, (req, res) => {
      const items = store.list(kind).map((t) => ({
        ...t,
        variables: kind === 'email' ? CATALOG.email[t.name]?.variables : undefined,
      }));
      res.json({ ok: true, kind, count: items.length, items });
    });

    router.get(`${base}/:name`, read, (req, res) => {
      const t = store.view(kind, nameParam(req));
      if (!t) throw new HttpError(404, 'not_found', 'No existe');
      res.set('ETag', `"${t.version}"`).json({ ok: true, ...t, variables: CATALOG[kind]?.[t.name]?.variables });
    });

    // Crea o reemplaza (nueva versión). Con If-Match: control de concurrencia.
    router.put(`${base}/:name`, write, asyncHandler(async (req, res) => {
      const name = nameParam(req);
      const fields = parse(templateWriteSchema, req.body);
      if (kind !== 'email') delete fields.layout;
      const existed = Boolean(store.view(kind, name));
      checkSource(kind, fields);
      const saved = await saveWithConflict(kind, name, fields, req);
      res.status(existed ? 200 : 201).set('ETag', `"${saved.version}"`).json({ ok: true, ...saved });
    }));

    // Actualización parcial: solo los campos enviados, el resto se conserva.
    router.patch(`${base}/:name`, write, asyncHandler(async (req, res) => {
      const name = nameParam(req);
      const current = store.view(kind, name);
      if (!current) throw new HttpError(404, 'not_found', 'No existe');
      const patch = parse(templatePatchSchema, req.body);
      const fields = {
        html: current.html, subject: current.subject, description: current.description,
        layout: current.layout, sampleData: current.sampleData, ...patch,
      };
      if (kind !== 'email') delete fields.layout;
      checkSource(kind, fields);
      const saved = await saveWithConflict(kind, name, fields, req);
      res.set('ETag', `"${saved.version}"`).json({ ok: true, ...saved });
    }));

    // Borra la versión personalizada. Si era builtin, vuelve al diseño original.
    router.delete(`${base}/:name`, write, asyncHandler(async (req, res) => {
      const name = nameParam(req);
      const view = store.view(kind, name);
      if (kind === 'layout' && name === 'base' && view?.source === 'builtin') {
        throw new HttpError(409, 'protected', 'El layout base incluido no se puede borrar');
      }
      const removed = await store.remove(kind, name, { actor: req.auth.keyId });
      if (!removed) throw new HttpError(404, 'not_found', 'No hay una versión personalizada que borrar');
      const after = store.view(kind, name);
      res.json({ ok: true, deleted: true, restoredBuiltin: Boolean(after) });
    }));

    router.get(`${base}/:name/versions`, read, (req, res) => {
      const name = nameParam(req);
      if (!store.view(kind, name)) throw new HttpError(404, 'not_found', 'No existe');
      res.json({ ok: true, name, versions: store.versions(kind, name) });
    });

    router.get(`${base}/:name/versions/:version`, read, (req, res) => {
      const v = store.getVersion(kind, nameParam(req), Number(req.params.version));
      if (!v) throw new HttpError(404, 'not_found', 'Versión no encontrada');
      res.json({ ok: true, ...v });
    });

    // Restaura una versión anterior creando una versión nueva (el historial no se reescribe).
    router.post(`${base}/:name/rollback`, write, asyncHandler(async (req, res) => {
      const name = nameParam(req);
      const version = Number(req.body?.version);
      const v = store.getVersion(kind, name, version);
      if (!v) throw new HttpError(404, 'not_found', 'Versión no encontrada');
      const { html, subject, description, layout, sampleData } = v;
      checkSource(kind, { html, subject, layout, sampleData });
      const saved = await saveWithConflict(kind, name, { html, subject, description, layout, sampleData, note: `rollback a v${version}` }, req);
      res.set('ETag', `"${saved.version}"`).json({ ok: true, rolledBackTo: version, ...saved });
    }));
  }

  // Vista previa de una plantilla de email guardada, con datos de ejemplo + context.
  router.post('/templates/:name/preview', read, (req, res) => {
    const name = nameParam(req);
    const t = store.view('email', name);
    if (!t) throw new HttpError(404, 'not_found', 'No existe');
    const { context, subject, preheader, format } = parse(renderSchema, req.body);
    const { attachments, ...out } = engine.render(name, { ...t.sampleData, ...(context || {}) }, { subject, preheader, iconMode: 'data' });
    if (format === 'html') return sendHtmlPreview(res, out.html);
    return res.json({ ok: true, ...out });
  });

  // ─────────────────────────────── Branding ───────────────────────────────

  router.get('/branding', read, (req, res) => res.json({ ok: true, branding: store.getBranding() }));

  router.put('/branding', admin, asyncHandler(async (req, res) => {
    const patch = parse(brandingSchema, req.body);
    const branding = await store.setBranding(patch, { actor: req.auth.keyId });
    res.json({ ok: true, branding });
  }));

  // ─────────────────────────────── Auditoría ───────────────────────────────

  router.get('/audit', admin, asyncHandler(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 1000);
    res.json({ ok: true, entries: await store.readAudit(limit) });
  }));

  router.get('/stats', requireScope(SCOPES.SEND), (req, res) => {
    res.json({ ok: true, queue: queue.metrics(), uptimeSeconds: Math.round(process.uptime()) });
  });

  router.get('/icons', read, (req, res) => res.json({
    ok: true,
    source: 'Material Symbols Rounded (Google, Apache 2.0)',
    usage: "{{icon 'shield_lock' '#4F46E5' 24}} o en partials: {{> hero icon='shield_lock'}}",
    icons: iconNames(),
  }));

  router.get('/kinds', read, (req, res) => res.json({ ok: true, kinds: KINDS, collections: COLLECTIONS }));

  return router;
}

// El HTML de una vista previa no debe poder ejecutar nada en el navegador.
export function sendHtmlPreview(res, html) {
  res
    .set('Content-Security-Policy', "default-src 'none'; img-src https: data:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; frame-ancestors 'self'; base-uri 'none'; form-action 'none'")
    .set('X-Frame-Options', 'SAMEORIGIN')
    .type('html')
    .send(html);
}
