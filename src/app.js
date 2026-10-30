// Construye la app Express a partir de sus dependencias (testeable sin red).

import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import helmet from 'helmet';
import { HttpError } from './http.js';
import { createAuth } from './security/auth.js';
import { hasIcon, iconPng, iconSvg, normalizeColor } from './templates/icon-render.js';
import { docsRouter } from './routes/docs.js';
import { legacyRouter } from './routes/legacy.js';
import { previewRouter } from './routes/preview.js';
import { v1Router } from './routes/v1.js';

const REQUEST_ID = /^[A-Za-z0-9._-]{8,100}$/;

// Rutas que reciben PDFs/XML en base64 y necesitan un body grande.
const LARGE_BODY = /^\/(send|send-html|notify\/[\w-]+|documents\/send|v1\/emails(\/batch)?)$/;

export function createApp({ config, logger, mailer, queue, store, engine }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy === 'false' ? false : config.trustProxy === 'true' ? true : Number(config.trustProxy) || config.trustProxy);

  // Request ID + log de acceso (sin cuerpos ni cabeceras sensibles).
  app.use((req, res, next) => {
    const incoming = req.get('x-request-id');
    req.id = incoming && REQUEST_ID.test(incoming) ? incoming : randomUUID();
    res.set('X-Request-Id', req.id);
    req.log = {
      info: (m, f) => logger.info(m, { requestId: req.id, ...f }),
      warn: (m, f) => logger.warn(m, { requestId: req.id, ...f }),
      error: (m, f) => logger.error(m, { requestId: req.id, ...f }),
    };
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      if (req.path === '/health' || req.path.startsWith('/docs/assets')) return;
      logger.info('http', {
        requestId: req.id,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Number((process.hrtime.bigint() - start) / 1_000_000n),
        key: req.auth?.keyId,
        ip: req.ip,
      });
    });
    next();
  });

  // Cabeceras de seguridad. CSP de API: nada se carga ni se embebe.
  app.use(helmet({
    contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    hsts: config.isProduction ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  }));
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    next();
  });

  // CORS: "*" = cualquiera (compatibilidad); lista = solo esos orígenes; vacío = ninguno.
  const origins = config.cors.origins;
  if (origins.includes('*')) {
    app.use(cors({ maxAge: 600 }));
  } else if (origins.length) {
    app.use(cors({ origin: origins, maxAge: 600, allowedHeaders: ['Content-Type', 'x-api-key', 'Authorization', 'Idempotency-Key', 'If-Match', 'X-Request-Id'], exposedHeaders: ['ETag', 'X-Request-Id', 'RateLimit', 'RateLimit-Policy'] }));
  }

  // Body JSON: grande solo donde viajan adjuntos.
  const bigJson = express.json({ limit: config.jsonLimit, strict: true });
  const smallJson = express.json({ limit: '1mb', strict: true });
  app.use((req, res, next) => (LARGE_BODY.test(req.path) ? bigJson : smallJson)(req, res, next));

  // ───────────── Rutas públicas ─────────────
  app.get('/health', (req, res) => res.json({ ok: true, service: 'mail-service' }));

  app.get('/ready', async (req, res) => {
    try {
      await Promise.race([mailer.verify(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))]);
      res.json({ ok: true, smtp: 'up', queue: queue.stats() });
    } catch {
      res.status(503).json({ ok: false, smtp: 'down' });
    }
  });

  // Íconos públicos (modo ICON_MODE=url). Solo nombres del set incluido y colores hex.
  app.get('/assets/icons/:file', (req, res, next) => {
    const m = /^([a-z0-9_]+(?:-fill)?)\.(png|svg)$/.exec(req.params.file);
    if (!m || !hasIcon(m[1])) return next(new HttpError(404, 'not_found', 'Not found'));
    const size = Math.min(Math.max(Number(req.query.size) || 24, 8), 128);
    const color = normalizeColor(req.query.color);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.set('Cross-Origin-Resource-Policy', 'cross-origin'); // los clientes webmail cargan la imagen
    if (m[2] === 'svg') return res.type('image/svg+xml').send(iconSvg(m[1], color, size));
    const png = iconPng(m[1], color, size);
    if (!png) return next(new HttpError(503, 'icons_unavailable', 'Íconos PNG no disponibles en este servidor'));
    return res.type('image/png').send(png);
  });

  if (config.features.docs) app.use(docsRouter({ config }));
  if (config.features.preview) app.use(previewRouter({ store, engine }));

  // ───────────── Rutas autenticadas ─────────────
  const limiterBase = {
    windowMs: config.rateLimit.windowMs,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res, next, options) => next(new HttpError(429, 'rate_limited', 'Too many requests', { retryAfterSeconds: Math.ceil(options.windowMs / 1000) })),
  };

  // Fuerza bruta de API keys: cuenta solo respuestas 401 por IP.
  const authFailLimiter = rateLimit({
    ...limiterBase,
    windowMs: 15 * 60 * 1000,
    limit: config.rateLimit.authFailMax,
    skipSuccessfulRequests: true,
    requestWasSuccessful: (req, res) => res.statusCode !== 401,
    keyGenerator: (req) => ipKeyGenerator(req.ip),
  });

  const keyOrIp = (req) => req.auth?.keyId ? `key:${req.auth.keyId}` : ipKeyGenerator(req.ip);
  const globalLimiter = rateLimit({ ...limiterBase, limit: config.rateLimit.max, keyGenerator: keyOrIp });
  const sendLimiter = rateLimit({ ...limiterBase, limit: config.rateLimit.sendMax, keyGenerator: keyOrIp });

  const auth = createAuth(config.auth);
  const isApiPath = (p) => p.startsWith('/v1/') || LARGE_BODY.test(p) || p.startsWith('/jobs/') || p === '/queue/stats';

  app.use((req, res, next) => (isApiPath(req.path) ? authFailLimiter(req, res, next) : next()));
  app.use((req, res, next) => (isApiPath(req.path) ? auth.authenticate(req, res, next) : next()));
  app.use((req, res, next) => (isApiPath(req.path) ? globalLimiter(req, res, next) : next()));
  app.use((req, res, next) => (req.method === 'POST' && LARGE_BODY.test(req.path) ? sendLimiter(req, res, next) : next()));

  app.use('/v1', v1Router({ config, engine, mailer, queue, store }));
  app.use(legacyRouter({ config, engine, mailer, queue }));

  // 404
  app.use((req, res, next) => next(new HttpError(404, 'not_found', 'Not found')));

  // Errores: nunca se filtran stacks ni mensajes internos de 5xx al cliente.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    let status = err.status || err.statusCode || 500;
    let code = err.code;
    let message = err.message;
    if (err.type === 'entity.too.large') { status = 413; code = 'payload_too_large'; message = 'Payload too large'; }
    else if (err.type === 'entity.parse.failed') { status = 400; code = 'invalid_json'; message = 'Invalid JSON'; }
    else if (err.code === 'QUEUE_FULL') { status = 503; code = 'queue_full'; message = 'Cola llena, reintenta en unos segundos'; }
    else if (!(err instanceof HttpError) && status < 500 && err.expose) { code = code || 'bad_request'; }
    else if (!(err instanceof HttpError)) { status = 500; code = 'internal_error'; message = 'Internal error'; }

    if (status >= 500) req.log?.error('http.error', { error: err.message, stack: config.isProduction ? undefined : err.stack });
    if (status === 429 && err.details?.retryAfterSeconds) res.set('Retry-After', String(err.details.retryAfterSeconds));
    res.status(status).json({ ok: false, error: message, code: typeof code === 'string' ? code : 'error', ...(err.details ? { details: err.details } : {}), requestId: req.id });
  });

  return app;
}
