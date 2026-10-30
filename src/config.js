// Configuración centralizada. Todo lo que viene de variables de entorno se
// valida y normaliza aquí; el resto del código nunca lee process.env directo.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const bool = (v, def = false) => (v === undefined || v === '' ? def : /^(1|true|yes|on)$/i.test(v));
const num = (v, def) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? def : Number(v));
const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

const HEX = /^#[0-9a-f]{6}$/i;

// API_KEYS="id:secreto:scope1|scope2,otro:secreto2:*"
// API_KEY (legado) equivale a una llave "default" con todos los permisos.
function parseApiKeys(env) {
  const keys = [];
  for (const entry of list(env.API_KEYS)) {
    // Los scopes también usan ":" (mail:send), así que todo lo que sigue al secreto son scopes.
    const [id, secret, ...rest] = entry.split(':');
    const scopes = rest.join(':') || '*';
    if (!id || !secret) throw new Error(`API_KEYS: entrada inválida "${id || entry.slice(0, 4)}…" (formato id:secreto:scopes)`);
    keys.push({ id, secret, scopes: scopes.split('|').filter(Boolean) });
  }
  if (env.API_KEY) keys.push({ id: 'default', secret: env.API_KEY, scopes: ['*'] });
  return keys;
}

export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';
  const isProduction = nodeEnv === 'production';
  const smtpPort = num(env.SMTP_PORT, 465);

  const config = {
    nodeEnv,
    isProduction,
    port: num(env.PORT, 3000),
    trustProxy: env.TRUST_PROXY ?? (isProduction ? '1' : 'false'),
    jsonLimit: env.JSON_LIMIT || '25mb',
    dataDir: path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data')),
    templatesDir: path.resolve(env.TEMPLATES_DIR || path.join(__dirname, 'templates')),
    logLevel: env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),

    auth: {
      keys: parseApiKeys(env),
      // Solo para desarrollo local: permite arrancar sin llaves. Nunca en producción.
      allowNoAuth: !isProduction && bool(env.ALLOW_INSECURE_NO_AUTH),
    },

    cors: {
      // Lista de orígenes permitidos; vacío = sin CORS (solo servidor-a-servidor).
      // Sin definir = cualquier origen (comportamiento previo, por compatibilidad).
      origins: env.CORS_ORIGINS === undefined ? ['*'] : list(env.CORS_ORIGINS),
    },

    rateLimit: {
      windowMs: num(env.RATE_LIMIT_WINDOW_MS, 60_000),
      max: num(env.RATE_LIMIT_MAX, 1200),
      sendMax: num(env.RATE_LIMIT_SEND_MAX, 600),
      authFailMax: num(env.RATE_LIMIT_AUTH_FAIL_MAX, 20),
    },

    features: {
      preview: bool(env.ENABLE_PREVIEW, true),
      docs: bool(env.ENABLE_DOCS, true),
    },

    mail: {
      transport: env.MAIL_TRANSPORT || 'smtp', // smtp | json (dry-run, no envía nada)
      fromName: env.MAIL_FROM_NAME || 'Mail Service',
      fromEmail: env.MAIL_FROM_EMAIL || env.SMTP_USER,
      replyTo: env.MAIL_REPLY_TO || undefined,
      maxRecipients: num(env.MAIL_MAX_RECIPIENTS, 50),
      allowedRecipientDomains: list(env.ALLOWED_RECIPIENT_DOMAINS).map((d) => d.toLowerCase()),
      smtp: {
        host: env.SMTP_HOST || 'smtp.hostinger.com',
        port: smtpPort,
        secure: env.SMTP_SECURE ? bool(env.SMTP_SECURE) : smtpPort === 465,
        user: env.SMTP_USER,
        pass: env.SMTP_PASS,
        maxConnections: num(env.SMTP_MAX_CONNECTIONS, 5),
        maxMessages: num(env.SMTP_MAX_MESSAGES, 100),
        connectionTimeout: num(env.SMTP_CONNECTION_TIMEOUT, 10_000),
        greetingTimeout: num(env.SMTP_GREETING_TIMEOUT, 10_000),
        socketTimeout: num(env.SMTP_SOCKET_TIMEOUT, 20_000),
      },
      dkim: env.DKIM_DOMAIN && env.DKIM_SELECTOR && env.DKIM_PRIVATE_KEY
        ? { domainName: env.DKIM_DOMAIN, keySelector: env.DKIM_SELECTOR, privateKey: env.DKIM_PRIVATE_KEY.replace(/\\n/g, '\n') }
        : null,
    },

    attachments: {
      maxCount: num(env.ATTACHMENT_MAX_COUNT, 10),
      maxBytes: num(env.ATTACHMENT_MAX_BYTES, 15 * 1024 * 1024),
      fetchTimeoutMs: num(env.ATTACHMENT_FETCH_TIMEOUT_MS, 15_000),
      // http se mantiene permitido por compatibilidad con integraciones existentes.
      allowHttp: bool(env.ATTACHMENT_ALLOW_HTTP, true),
      // Hosts internos permitidos aunque resuelvan a IP privada (ej. api.interna.local).
      trustedHosts: list(env.ATTACHMENT_TRUSTED_HOSTS).map((h) => h.toLowerCase()),
      // Si se define, solo se descargan adjuntos de estos hosts (y subdominios).
      urlAllowlist: list(env.ATTACHMENT_URL_ALLOWLIST).map((h) => h.toLowerCase()),
    },

    queue: {
      concurrency: num(env.QUEUE_CONCURRENCY, 5),
      maxAttempts: num(env.QUEUE_MAX_ATTEMPTS, 3),
      retryBaseMs: num(env.QUEUE_RETRY_BASE_MS, 2000),
      jobTtlMs: num(env.QUEUE_JOB_TTL_MS, 30 * 60 * 1000),
      maxPending: num(env.QUEUE_MAX_PENDING, 5000),
    },

    icons: {
      // cid = PNG incrustado en el correo (recomendado) | url = PNG servido desde PUBLIC_URL
      mode: env.ICON_MODE === 'url' ? 'url' : 'cid',
      publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
    },

    brand: {
      name: env.BRAND_NAME || env.MAIL_FROM_NAME || 'Mail Service',
      logoUrl: env.BRAND_LOGO_URL || '',
      primaryColor: HEX.test(env.BRAND_PRIMARY_COLOR || '') ? env.BRAND_PRIMARY_COLOR : '#4F46E5',
      accentColor: HEX.test(env.BRAND_ACCENT_COLOR || '') ? env.BRAND_ACCENT_COLOR : '#06B6D4',
      website: env.BRAND_WEBSITE || '',
      supportEmail: env.BRAND_SUPPORT_EMAIL || env.MAIL_FROM_EMAIL || '',
      address: env.BRAND_ADDRESS || '',
      footerNote: env.BRAND_FOOTER_NOTE || '',
      socialLinks: [],
      lang: env.BRAND_LANG || 'es',
    },
  };

  return config;
}

// Revisa la configuración. `errors` impiden arrancar de forma segura; `warnings` solo se registran.
export function checkConfig(config) {
  const errors = [];
  const warnings = [];
  if (config.auth.keys.length === 0 && !config.auth.allowNoAuth) {
    errors.push('No hay API keys configuradas (API_KEYS o API_KEY). El servicio no arranca sin autenticación.');
  }
  for (const k of config.auth.keys) {
    if (k.secret.length < 32) warnings.push(`La API key "${k.id}" es corta; usa al menos 32 caracteres aleatorios (openssl rand -hex 32).`);
  }
  const ids = config.auth.keys.map((k) => k.id);
  if (new Set(ids).size !== ids.length) errors.push('API_KEYS contiene ids duplicados.');
  if (config.mail.transport === 'smtp' && (!config.mail.smtp.user || !config.mail.smtp.pass)) {
    warnings.push('SMTP_USER / SMTP_PASS no definidos (usa MAIL_TRANSPORT=json para pruebas sin envío).');
  }
  if (config.isProduction && config.cors.origins.includes('*')) {
    warnings.push('CORS abierto a cualquier origen. Define CORS_ORIGINS con tus dominios.');
  }
  if (config.auth.allowNoAuth && config.auth.keys.length === 0) {
    warnings.push('ALLOW_INSECURE_NO_AUTH activo: cualquier petición está autorizada (solo desarrollo).');
  }
  return { errors, warnings };
}
