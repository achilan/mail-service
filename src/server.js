import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTransport } from 'nodemailer';
import hbs from 'nodemailer-express-handlebars';
import { engine } from 'express-handlebars';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Config
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_PASS = process.env.GMAIL_PASS;
const MAIL_FROM_NAME = process.env.MAIL_FROM_NAME || 'Mail Service';
const MAIL_FROM_EMAIL = process.env.MAIL_FROM_EMAIL || GMAIL_USER;

if (!API_KEY) console.warn('WARN: API_KEY no definido en .env');
if (!GMAIL_USER || !GMAIL_PASS) console.warn('WARN: GMAIL_USER / GMAIL_PASS no definidos');

// Express app
const app = express();
app.use(cors());
app.use(express.json());
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

// Nodemailer transporter (Gmail SMTP)
const transporter = createTransport({
  service: 'gmail',
  auth: {
    user: GMAIL_USER,
    pass: GMAIL_PASS, // App Password recomendado
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

app.listen(PORT, () => {
  console.log(`Mail service escuchando en http://localhost:${PORT}`);
});
