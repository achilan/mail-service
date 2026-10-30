// Descarga segura de adjuntos por URL (protección SSRF).
// - http/https, sin credenciales en la URL; IPs privadas/internas bloqueadas
//   salvo hosts declarados de confianza (ATTACHMENT_TRUSTED_HOSTS).
// - La IP se valida en el momento de conectar (hook `lookup`), así un DNS
//   rebinding no puede colar una IP interna entre la validación y la conexión.
// - Redirecciones seguidas manualmente (máx. 3), cada salto revalidado.
// - Límite de tamaño y timeout.

import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { HttpError } from '../http.js';

const BLOCKED_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

const v4ToInt = (ip) => ip.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;

function isBlockedV4(ip) {
  const n = v4ToInt(ip);
  return BLOCKED_V4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (v4ToInt(base) & mask);
  });
}

export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) return isBlockedV4(ip);
  if (!net.isIPv6(ip)) return true;
  const lower = ip.toLowerCase();
  // IPv4 mapeada/compatible (::ffff:127.0.0.1)
  const mapped = lower.match(/^(?:0*:)*(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedV4(mapped[1]);
  if (lower === '::' || lower === '::1') return true;
  const first = parseInt(lower.split(':')[0] || '0', 16);
  if ((first & 0xfe00) === 0xfc00) return true;  // fc00::/7 ULA
  if ((first & 0xffc0) === 0xfe80) return true;  // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true;  // ff00::/8 multicast
  if (lower.startsWith('64:ff9b:')) return true; // NAT64
  if (lower.startsWith('2001:db8:')) return true; // documentación
  return false;
}

function hostAllowed(hostname, allowlist) {
  if (allowlist.length === 0) return true;
  const h = hostname.toLowerCase();
  return allowlist.some((a) => h === a || h.endsWith(`.${a}`));
}

function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options.family || 4 }];
    const bad = list.find((a) => isPrivateAddress(a.address));
    if (bad || list.length === 0) {
      return callback(Object.assign(new Error(`Destino bloqueado (${hostname})`), { code: 'EBLOCKED' }));
    }
    if (options.all) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
}

const isTrusted = (host, trustedHosts = []) => hostAllowed(host, trustedHosts) && trustedHosts.length > 0;

export function validateAttachmentUrl(raw, { allowHttp = false, urlAllowlist = [], trustedHosts = [] } = {}) {
  let url;
  try { url = new URL(raw); } catch { throw new HttpError(400, 'invalid_url', 'URL de adjunto inválida'); }
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
    throw new HttpError(400, 'invalid_url', 'Solo se permiten URLs https para adjuntos');
  }
  if (url.username || url.password) throw new HttpError(400, 'invalid_url', 'La URL no puede incluir credenciales');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  // Hosts internos que el operador declaró de confianza explícitamente.
  if (isTrusted(host, trustedHosts)) return url;
  if (net.isIP(host) && isPrivateAddress(host)) throw new HttpError(400, 'invalid_url', 'Destino de URL bloqueado');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new HttpError(400, 'invalid_url', 'Destino de URL bloqueado');
  }
  if (!hostAllowed(host, urlAllowlist)) throw new HttpError(400, 'invalid_url', `Host no permitido: ${host}`);
  return url;
}

function requestOnce(url, { timeoutMs, maxBytes, trustedHosts }) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.get(url, {
      lookup: isTrusted(url.hostname, trustedHosts) ? dns.lookup : safeLookup,
      timeout: timeoutMs,
      headers: { 'user-agent': 'mail-service/2 (+attachment-fetch)', accept: '*/*' },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve({ redirect: new URL(res.headers.location, url).toString() });
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`descarga falló con estado ${res.statusCode}`));
      }
      const declared = Number(res.headers['content-length'] || 0);
      if (declared > maxBytes) {
        res.destroy();
        return reject(new Error('el adjunto supera el tamaño máximo'));
      }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) {
          res.destroy();
          reject(new Error('el adjunto supera el tamaño máximo'));
        } else chunks.push(c);
      });
      res.on('end', () => resolve({ buffer: Buffer.concat(chunks), contentType: res.headers['content-type'] }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout descargando adjunto')));
    req.on('error', reject);
    // Tiempo total máximo (el `timeout` de arriba es por inactividad del socket).
    setTimeout(() => req.destroy(new Error('timeout descargando adjunto')), timeoutMs * 2).unref();
  });
}

export async function safeFetch(rawUrl, opts = {}) {
  const { maxRedirects = 3, timeoutMs = 15_000, maxBytes = 15 * 1024 * 1024 } = opts;
  let current = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const url = validateAttachmentUrl(current, opts);
    const result = await requestOnce(url, { timeoutMs, maxBytes, trustedHosts: opts.trustedHosts });
    if (!result.redirect) return result;
    current = result.redirect;
  }
  throw new Error('demasiadas redirecciones');
}
