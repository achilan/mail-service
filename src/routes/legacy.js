// Endpoints originales. Mantienen EXACTAMENTE las mismas rutas, cuerpos de
// petición y respuestas que la versión anterior (hay clientes en producción).
// Lo único que cambia es la seguridad interna y el diseño del correo.

import { Router } from 'express';
import { asyncHandler, HttpError } from '../http.js';
import { requireScope, SCOPES } from '../security/auth.js';
import { checkRecipients, cleanSubject, TEMPLATE_NAME } from '../validation.js';
import { resolveContent, safeFilename } from '../mail/attachments.js';

// Etiquetas legibles por tipo de comprobante.
export const TIPO_DOC_LABELS = {
  factura: 'Factura',
  nota_credito: 'Nota de Crédito',
  nota_debito: 'Nota de Débito',
  retencion: 'Comprobante de Retención',
  guia_remision: 'Guía de Remisión',
  liquidacion: 'Liquidación de Compra',
  cotizacion: 'Cotización',
  general: 'General',
};

// Formas largas habituales que deben mapear a la clave canónica.
const TIPO_ALIASES = {
  nota_de_credito: 'nota_credito',
  nota_de_debito: 'nota_debito',
  comprobante_de_retencion: 'retencion',
  guia_de_remision: 'guia_remision',
  liquidacion_de_compra: 'liquidacion',
};

// Normaliza el tipo recibido: minúsculas, sin tildes y espacios/guiones -> "_".
// Así "Cotización", "COTIZACION" o "nota de credito" mapean a la clave canónica.
export function normalizeTipoDocumento(value) {
  if (typeof value !== 'string') return '';
  const key = value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return TIPO_ALIASES[key] || key;
}

// Responde con el mismo formato de error que la API original: { error: '...' }.
function legacy(fn, failMessage = 'Send failed') {
  return asyncHandler(async (req, res, next) => {
    try {
      await fn(req, res, next);
    } catch (err) {
      if (err instanceof HttpError && err.status < 500) throw err;
      req.log?.error('legacy.failed', { route: req.path, error: err.message });
      res.status(500).json({ error: failMessage });
    }
  });
}

export function legacyRouter({ config, engine, mailer, queue }) {
  const router = Router();
  const send = requireScope(SCOPES.SEND);
  const recipientsOf = (body) => checkRecipients(body, config.mail);

  async function sendTemplate({ recipients, subject, template, context, attachments }) {
    const rendered = engine.render(template, context, { subject });
    return mailer.send({
      ...recipients, subject: rendered.subject, html: rendered.html, text: rendered.text,
      attachments: [...rendered.attachments, ...(attachments || [])],
    });
  }

  // Generic send
  router.post('/send', send, legacy(async (req, res) => {
    const { to, subject, template = 'generic', context = {} } = req.body || {};
    const recipients = recipientsOf({ to });
    if (!subject) return res.status(400).json({ error: 'Subject required' });
    if (typeof template !== 'string' || !TEMPLATE_NAME.test(template)) {
      throw new HttpError(400, 'template_not_found', 'Template not found');
    }
    const ctx = context && typeof context === 'object' && !Array.isArray(context) ? context : {};
    const info = await sendTemplate({ recipients, subject: cleanSubject(subject), template, context: ctx });
    return res.json({ ok: true, id: info.messageId });
  }));

  // Login success notification
  router.post('/notify/login-success', send, legacy(async (req, res) => {
    const { to, ...context } = req.body || {};
    const recipients = recipientsOf({ to });
    const info = await sendTemplate({ recipients, subject: 'Inicio de sesión exitoso', template: 'login-success', context });
    return res.json({ ok: true, id: info.messageId });
  }));

  // New order notification
  router.post('/notify/new-order', send, legacy(async (req, res) => {
    const { to, orderId, items = [], ...rest } = req.body || {};
    const recipients = recipientsOf({ to });
    const info = await sendTemplate({
      recipients,
      subject: cleanSubject(`Nueva orden #${orderId}`),
      template: 'new-order',
      context: { ...rest, orderId, items: Array.isArray(items) ? items : [] },
    });
    return res.json({ ok: true, id: info.messageId });
  }));

  // Generic document / general-purpose send
  router.post('/notify/generic', send, legacy(async (req, res) => {
    const { to, subject, title, message, details = [], ctaUrl, ctaText, ...rest } = req.body || {};
    const recipients = recipientsOf({ to });
    if (!subject) return res.status(400).json({ error: 'Subject required' });
    const info = await sendTemplate({
      recipients,
      subject: cleanSubject(subject),
      template: 'generic',
      context: { ...rest, title: title || subject, message, details: Array.isArray(details) ? details : [], ctaUrl, ctaText },
    });
    return res.json({ ok: true, id: info.messageId });
  }));

  // Custom notification
  router.post('/notify/custom', send, legacy(async (req, res) => {
    const { to, title, message, ctaUrl, ctaText, ...rest } = req.body || {};
    const recipients = recipientsOf({ to });
    const subject = cleanSubject(title || 'Notificación');
    const info = await sendTemplate({
      recipients,
      subject,
      template: 'notification',
      context: { ...rest, title: subject, message, ctaUrl, ctaText },
    });
    return res.json({ ok: true, id: info.messageId });
  }));

  // Send custom HTML email (HTML arbitrario: requiere el permiso mail:send:raw)
  router.post('/send-html', requireScope(SCOPES.SEND_RAW), legacy(async (req, res) => {
    const { to, subject, html, text } = req.body || {};
    const recipients = recipientsOf({ to });
    if (!subject) return res.status(400).json({ error: 'Subject required' });
    if (!html) return res.status(400).json({ error: 'HTML content required' });
    if (typeof html !== 'string' || html.length > 2 * 1024 * 1024) {
      throw new HttpError(413, 'payload_too_large', 'HTML demasiado grande (máx. 2 MB)');
    }
    const info = await mailer.send({
      ...recipients,
      subject: cleanSubject(subject),
      html,
      text: typeof text === 'string' ? text : undefined,
    });
    return res.json({ ok: true, id: info.messageId });
  }));

  // ─────────────────────── Documentos electrónicos (RIDE) ───────────────────────

  const fetchOpts = { ...config.attachments };

  // Worker de la cola: arma y envía el correo con adjuntos.
  queue.setHandler('document', async (payload) => {
    const {
      to, cc, bcc, destinatarioNombre = 'Cliente',
      tipoDocumento, documento = {}, adjuntos = {}, subject: customSubject,
      title, body,
    } = payload;
    const recipients = checkRecipients({ to, cc, bcc }, config.mail);

    // Tipo general: envía título, cuerpo y PDF sin datos de comprobante.
    if (tipoDocumento === 'general') {
      const subject = cleanSubject(customSubject || title || 'Documento');
      const pdf = await resolveContent({ base64: adjuntos.pdfBase64, url: adjuntos.pdfUrl }, 'PDF', fetchOpts);
      if (!pdf) throw new Error('Falta el PDF (adjuntos.pdfBase64 o adjuntos.pdfUrl)');
      const baseName = safeFilename(title || 'documento', 'documento').replace(/\.pdf$/i, '');
      const rendered = engine.render('generic', {
        title: subject, message: body, details: Array.isArray(payload.details) ? payload.details : undefined, icon: 'description',
      }, { subject });
      const info = await mailer.send({
        ...recipients, subject, html: rendered.html, text: rendered.text,
        attachments: [...rendered.attachments, { filename: `${baseName}.pdf`, content: pdf, contentType: 'application/pdf' }],
      });
      return { messageId: info.messageId };
    }

    const tipoLabel = TIPO_DOC_LABELS[tipoDocumento] || 'Comprobante Electrónico';
    const numero = documento.numero || '';
    const subject = cleanSubject(customSubject
      || `${tipoLabel} ${numero}`.trim() + (documento.razonSocialEmisor ? ` - ${documento.razonSocialEmisor}` : ''));

    const pdf = await resolveContent({ base64: adjuntos.pdfBase64, url: adjuntos.pdfUrl }, 'PDF', fetchOpts);
    if (!pdf) throw new Error('Falta el PDF del RIDE (adjuntos.pdfBase64 o adjuntos.pdfUrl)');
    const xml = await resolveContent({ base64: adjuntos.xmlBase64, url: adjuntos.xmlUrl }, 'XML', fetchOpts);

    const baseName = safeFilename(String(numero || documento.claveAcceso || tipoDocumento || 'documento'), 'documento');
    const attachments = [{ filename: `${baseName}.pdf`, content: pdf, contentType: 'application/pdf' }];
    if (xml) attachments.push({ filename: `${baseName}.xml`, content: xml, contentType: 'application/xml' });

    const rendered = engine.render('document', {
      tipoLabel,
      destinatarioNombre,
      razonSocialEmisor: documento.razonSocialEmisor || config.mail.fromName,
      numero,
      fechaEmision: documento.fechaEmision,
      total: documento.total,
      currency: documento.moneda,
      claveAcceso: documento.claveAcceso,
      conXml: Boolean(xml),
    }, { subject });

    const info = await mailer.send({
      ...recipients, subject, html: rendered.html, text: rendered.text,
      attachments: [...rendered.attachments, ...attachments],
    });
    return { messageId: info.messageId };
  });

  // Encola el envío del documento y responde 202 al instante (no bloquea la UI).
  router.post('/documents/send', send, legacy(async (req, res) => {
    const { to, cc, bcc, tipoDocumento, adjuntos = {} } = req.body || {};
    checkRecipients({ to, cc, bcc }, config.mail);
    const tipoNormalizado = normalizeTipoDocumento(tipoDocumento);
    if (!tipoNormalizado || !TIPO_DOC_LABELS[tipoNormalizado]) {
      return res.status(400).json({ error: 'tipoDocumento inválido', validos: Object.keys(TIPO_DOC_LABELS) });
    }
    if (!adjuntos || (!adjuntos.pdfBase64 && !adjuntos.pdfUrl)) {
      return res.status(400).json({ error: 'Se requiere adjuntos.pdfBase64 o adjuntos.pdfUrl' });
    }
    // Validación temprana: base64 corrupto o URL bloqueada se rechazan ya, no en el worker.
    for (const [b64, url, label] of [[adjuntos.pdfBase64, adjuntos.pdfUrl, 'PDF'], [adjuntos.xmlBase64, adjuntos.xmlUrl, 'XML']]) {
      if (b64 && (typeof b64 !== 'string' || !/^[A-Za-z0-9+/\s]*={0,2}$/.test(b64))) {
        throw new HttpError(400, 'invalid_attachment', `adjuntos.${label.toLowerCase()}Base64 inválido`);
      }
      if (!b64 && url !== undefined && typeof url !== 'string') {
        throw new HttpError(400, 'invalid_url', `adjuntos.${label.toLowerCase()}Url inválida`);
      }
    }

    // Guarda la clave canónica para que el worker use siempre el valor correcto.
    const payload = { ...req.body, tipoDocumento: tipoNormalizado };
    const { job } = queue.enqueue('document', payload, {
      owner: req.auth.keyId,
      idempotencyKey: req.get('idempotency-key')?.slice(0, 200) || null,
    });
    return res.status(202).json({ ok: true, jobId: job.id, status: job.status });
  }, 'Enqueue failed'));

  // Consulta el estado de un envío encolado (para que la UI haga polling).
  router.get('/jobs/:id', send, (req, res) => {
    const job = queue.getJob(req.params.id);
    const visible = job && (job.owner === req.auth.keyId || req.auth.scopes.has('*') || req.auth.scopes.has(SCOPES.ADMIN));
    if (!visible) return res.status(404).json({ error: 'Job no encontrado o expirado' });
    return res.json({
      ok: true,
      jobId: job.id,
      status: job.status,
      attempts: job.attempts,
      result: job.result,
      error: job.error,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    });
  });

  // Métricas básicas de la cola.
  router.get('/queue/stats', send, (req, res) => {
    res.json({ ok: true, ...queue.stats() });
  });

  return router;
}
