// Autenticación por API key con scopes.
// - Comparación en tiempo constante (sobre hashes SHA-256 de igual longitud).
// - Acepta `x-api-key` o `Authorization: Bearer <key>`.
// - Nunca registra el valor de la llave, solo su id.

import { createHash, timingSafeEqual } from 'node:crypto';
import { HttpError } from '../http.js';

export const SCOPES = {
  SEND: 'mail:send',           // enviar correos con plantillas
  SEND_RAW: 'mail:send:raw',   // enviar HTML arbitrario (/send-html)
  TEMPLATES_READ: 'templates:read',
  TEMPLATES_WRITE: 'templates:write',
  ADMIN: 'admin',              // branding, auditoría, jobs de otras llaves
};

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest();

export function createAuth({ keys, allowNoAuth }) {
  const hashed = keys.map((k) => ({ id: k.id, scopes: new Set(k.scopes), hash: sha256(k.secret) }));

  function identify(presented) {
    if (typeof presented !== 'string' || presented.length === 0 || presented.length > 512) return null;
    const h = sha256(presented);
    let match = null;
    // Recorre todas las llaves siempre (sin cortocircuito) para no filtrar timing.
    for (const k of hashed) if (timingSafeEqual(h, k.hash)) match = k;
    return match;
  }

  function extractKey(req) {
    const header = req.get('x-api-key');
    if (header) return header.trim();
    const authz = req.get('authorization');
    if (authz && /^Bearer\s+/i.test(authz)) return authz.replace(/^Bearer\s+/i, '').trim();
    return null;
  }

  // Middleware: autentica y deja `req.auth = { keyId, scopes }`.
  function authenticate(req, _res, next) {
    if (allowNoAuth && hashed.length === 0) {
      req.auth = { keyId: 'anonymous-dev', scopes: new Set(['*']) };
      return next();
    }
    const key = identify(extractKey(req));
    if (!key) return next(new HttpError(401, 'unauthorized', 'Unauthorized'));
    req.auth = { keyId: key.id, scopes: key.scopes };
    return next();
  }

  return { authenticate, identify };
}

export function hasScope(auth, scope) {
  if (!auth) return false;
  if (auth.scopes.has('*') || auth.scopes.has(scope)) return true;
  // admin implica todo lo demás; templates:write implica templates:read.
  if (auth.scopes.has(SCOPES.ADMIN)) return true;
  if (scope === SCOPES.TEMPLATES_READ && auth.scopes.has(SCOPES.TEMPLATES_WRITE)) return true;
  return false;
}

export const requireScope = (scope) => (req, _res, next) => {
  if (hasScope(req.auth, scope)) return next();
  return next(new HttpError(403, 'forbidden', `La API key no tiene el permiso "${scope}"`));
};
