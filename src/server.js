import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTransport } from 'nodemailer';
import hbs from 'nodemailer-express-handlebars';
import { engine } from 'express-handlebars';
import { enqueue, getJob, setHandler, stats } from './queue.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Config
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.hostinger.com';
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_SECURE = process.env.SMTP_SECURE
  ? process.env.SMTP_SECURE === 'true'
  : SMTP_PORT === 465;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const MAIL_FROM_NAME = process.env.MAIL_FROM_NAME || 'Mail Service';
const MAIL_FROM_EMAIL = process.env.MAIL_FROM_EMAIL || SMTP_USER;

if (!API_KEY) console.warn('WARN: API_KEY no definido en .env');
if (!SMTP_USER || !SMTP_PASS) console.warn('WARN: SMTP_USER / SMTP_PASS no definidos');

// Express app
const app = express();
app.use(cors());
// Límite alto porque los PDF/XML viajan en base64 dentro del JSON.
app.use(express.json({ limit: process.env.JSON_LIMIT || '25mb' }));
app.use(morgan('dev'));

// API Key Middleware
function requireApiKey(req, res, next) {
  const key = req.header('x-api-key');
  console.log('API Key recibida:', key);
  if (!API_KEY || key === API_KEY) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

// Handlebars for server-side preview (optional)
app.engine('handlebars', engine());
app.set('view engine', 'handlebars');
app.set('views', path.join(__dirname, 'templates'));

// Nodemailer transporter (SMTP genérico, ej. Hostinger)
const transporter = createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_SECURE, // true para puerto 465, false para 587 (STARTTLS)
  auth: {
    user: SMTP_USER,
    pass: SMTP_PASS,
  },
});

// Attach Handlebars templates to Nodemailer
transporter.use(
  'compile',
  hbs({
    viewEngine: {
      extname: '.hbs',
      layoutsDir: path.join(__dirname, 'templates', 'layouts'),
      defaultLayout: 'base',
      partialsDir: path.join(__dirname, 'templates', 'partials'),
    },
    viewPath: path.join(__dirname, 'templates'),
    extName: '.hbs',
  })
);

// Helpers
function sendTemplateMail({ to, subject, template, context }) {
  const from = `${MAIL_FROM_NAME} <${MAIL_FROM_EMAIL}>`;
  return transporter.sendMail({
    from,
    to,
    subject,
    template,
    context: {
      ...context,
      MAIL_FROM_NAME,
      MAIL_FROM_EMAIL,
      subject
    },
  });
}

function validateEmailString(email) {
  return typeof email === 'string' && email.includes('@');
}

// Routes
app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'mail-service' });
});

// Preview routes (for development)
app.get('/preview/:template', (req, res) => {
  const { template } = req.params;
  const sampleData = {
    generic: { title: 'Bienvenido', message: 'Gracias por registrarte en nuestro servicio.' },
    'login-success': { userName: 'Anthony' },
    'new-order': { 
      orderId: 'A-001', 
      orderTotal: 123.45, 
      items: [
        { name: 'Producto Premium', qty: 2, price: 50.00 },
        { name: 'Servicio Extra', qty: 1, price: 23.45 }
      ]
    },
    notification: { 
      title: 'Notificación Importante', 
      message: 'Tu acción fue procesada exitosamente.', 
      ctaUrl: 'https://example.com', 
      ctaText: 'Ver Detalles' 
    }
  };
  
  const context = {
    ...sampleData[template] || sampleData.generic,
    MAIL_FROM_NAME,
    MAIL_FROM_EMAIL,
    subject: 'Vista previa del template'
  };
  
  res.render(template, { layout: 'base', ...context });
});

// Generic send
app.post('/send', requireApiKey, async (req, res) => {
  try {
    const { to, subject, template = 'generic', context = {} } = req.body || {};
    if (!validateEmailString(to)) return res.status(400).json({ error: 'Invalid recipient' });
    if (!subject) return res.status(400).json({ error: 'Subject required' });

    const info = await sendTemplateMail({ to, subject, template, context });
    res.json({ ok: true, id: info.messageId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Send failed' });
  }
});

// Login success notification
app.post('/notify/login-success', requireApiKey, async (req, res) => {
  try {
    const { to, userName } = req.body || {};
    if (!validateEmailString(to)) return res.status(400).json({ error: 'Invalid recipient' });

    const subject = 'Inicio de sesión exitoso';
    const info = await sendTemplateMail({
      to,
      subject,
      template: 'login-success',
      context: { userName },
    });
    res.json({ ok: true, id: info.messageId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Send failed' });
  }
});

// New order notification
app.post('/notify/new-order', requireApiKey, async (req, res) => {
  try {
    const { to, orderId, orderTotal, items = [] } = req.body || {};
    if (!validateEmailString(to)) return res.status(400).json({ error: 'Invalid recipient' });

    const subject = `Nueva orden #${orderId}`;
    const info = await sendTemplateMail({
      to,
      subject,
      template: 'new-order',
      context: { orderId, orderTotal, items },
    });
    res.json({ ok: true, id: info.messageId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Send failed' });
  }
});

// Custom notification
app.post('/notify/custom', requireApiKey, async (req, res) => {
  try {
    const { to, title, message, ctaUrl, ctaText } = req.body || {};
    if (!validateEmailString(to)) return res.status(400).json({ error: 'Invalid recipient' });

    const subject = title || 'Notificación';
    const info = await sendTemplateMail({
      to,
      subject,
      template: 'notification',
      context: { title: subject, message, ctaUrl, ctaText },
    });
    res.json({ ok: true, id: info.messageId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Send failed' });
  }
});

// Send custom HTML email
app.post('/send-html', requireApiKey, async (req, res) => {
  try {
    const { to, subject, html, text } = req.body || {};
    if (!validateEmailString(to)) return res.status(400).json({ error: 'Invalid recipient' });
    if (!subject) return res.status(400).json({ error: 'Subject required' });
    if (!html) return res.status(400).json({ error: 'HTML content required' });

    const from = `${MAIL_FROM_NAME} <${MAIL_FROM_EMAIL}>`;
    const info = await transporter.sendMail({
      from,
      to,
      subject,
      html,
      text: text || html.replace(/<[^>]*>/g, ''), // Strip HTML tags for text fallback
    });
    
    res.json({ ok: true, id: info.messageId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Send failed' });
  }
});

// ───────────────────────────── Documentos electrónicos (RIDE) ─────────────────────────────

// Etiquetas legibles por tipo de comprobante.
const TIPO_DOC_LABELS = {
  factura: 'Factura',
  nota_credito: 'Nota de Crédito',
  nota_debito: 'Nota de Débito',
  retencion: 'Comprobante de Retención',
  guia_remision: 'Guía de Remisión',
  liquidacion: 'Liquidación de Compra',
  cotizacion: 'Cotización',
};

// Normaliza el tipo recibido: minúsculas, sin tildes y espacios/guiones -> "_".
// Así "Cotización", "COTIZACION" o "nota de credito" mapean a la clave canónica.
function normalizeTipoDocumento(value) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

// Obtiene el contenido del PDF/XML como Buffer, ya sea desde base64 o desde una URL.
async function resolveAttachment({ base64, url }) {
  if (base64) return Buffer.from(base64, 'base64');
  if (url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`No se pudo descargar adjunto (${resp.status}) desde ${url}`);
    return Buffer.from(await resp.arrayBuffer());
  }
  return null;
}

// Handler que ejecuta el worker de la cola: arma y envía el correo con adjuntos.
setHandler(async (payload) => {
  const {
    to, cc, bcc, destinatarioNombre = 'Cliente',
    tipoDocumento, documento = {}, adjuntos = {}, subject: customSubject,
  } = payload;

  const tipoLabel = TIPO_DOC_LABELS[tipoDocumento] || 'Comprobante Electrónico';
  const numero = documento.numero || '';
  const subject = customSubject
    || `${tipoLabel} ${numero}`.trim() + (documento.razonSocialEmisor ? ` - ${documento.razonSocialEmisor}` : '');

  const pdfBuffer = await resolveAttachment({ base64: adjuntos.pdfBase64, url: adjuntos.pdfUrl });
  if (!pdfBuffer) throw new Error('Falta el PDF del RIDE (adjuntos.pdfBase64 o adjuntos.pdfUrl)');
  const xmlBuffer = await resolveAttachment({ base64: adjuntos.xmlBase64, url: adjuntos.xmlUrl });

  const baseName = (numero || documento.claveAcceso || tipoDocumento || 'documento').replace(/[^\w.-]/g, '_');
  const attachments = [{ filename: `${baseName}.pdf`, content: pdfBuffer, contentType: 'application/pdf' }];
  if (xmlBuffer) attachments.push({ filename: `${baseName}.xml`, content: xmlBuffer, contentType: 'application/xml' });

  const from = `${MAIL_FROM_NAME} <${MAIL_FROM_EMAIL}>`;
  const info = await transporter.sendMail({
    from,
    to,
    cc,
    bcc,
    subject,
    template: 'document',
    attachments,
    context: {
      tipoLabel,
      destinatarioNombre,
      razonSocialEmisor: documento.razonSocialEmisor || MAIL_FROM_NAME,
      numero,
      fechaEmision: documento.fechaEmision,
      total: documento.total,
      claveAcceso: documento.claveAcceso,
      conXml: Boolean(xmlBuffer),
      MAIL_FROM_NAME,
      MAIL_FROM_EMAIL,
      subject,
    },
  });
  return { messageId: info.messageId };
});

// Encola el envío del documento y responde 202 al instante (no bloquea la UI).
app.post('/documents/send', requireApiKey, (req, res) => {
  try {
    const { to, tipoDocumento, adjuntos = {} } = req.body || {};
    if (!validateEmailString(to)) return res.status(400).json({ error: 'Invalid recipient' });
    const tipoNormalizado = normalizeTipoDocumento(tipoDocumento);
    if (!tipoNormalizado || !TIPO_DOC_LABELS[tipoNormalizado]) {
      return res.status(400).json({ error: 'tipoDocumento inválido', validos: Object.keys(TIPO_DOC_LABELS) });
    }
    // Guarda la clave canónica para que el worker use siempre el valor correcto.
    req.body.tipoDocumento = tipoNormalizado;
    if (!adjuntos.pdfBase64 && !adjuntos.pdfUrl) {
      return res.status(400).json({ error: 'Se requiere adjuntos.pdfBase64 o adjuntos.pdfUrl' });
    }

    const job = enqueue('document', req.body);
    res.status(202).json({ ok: true, jobId: job.id, status: job.status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Enqueue failed' });
  }
});

// Consulta el estado de un envío encolado (para que la UI haga polling).
app.get('/jobs/:id', requireApiKey, (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job no encontrado o expirado' });
  res.json({
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
app.get('/queue/stats', requireApiKey, (req, res) => {
  res.json({ ok: true, ...stats() });
});

app.listen(PORT, () => {
  console.log(`Mail service escuchando en http://localhost:${PORT}`);
});
