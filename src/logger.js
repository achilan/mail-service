// Logger JSON mínimo, sin dependencias. Redacta campos sensibles por nombre
// para que secretos, cuerpos de correo o adjuntos nunca terminen en los logs.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const SENSITIVE = /^(authorization|x-api-key|api_?key|secret|pass(word)?|token|html|body|content|.*base64)$/i;

function redact(value, depth = 0) {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE.test(k) ? '[REDACTED]' : redact(v, depth + 1);
  }
  return out;
}

export function createLogger({ level = 'info', silent = false } = {}) {
  const min = LEVELS[level] ?? LEVELS.info;
  const write = (lvl, msg, fields) => {
    if (silent || LEVELS[lvl] < min) return;
    const line = { time: new Date().toISOString(), level: lvl, msg, ...redact(fields || {}) };
    const out = lvl === 'error' || lvl === 'warn' ? process.stderr : process.stdout;
    out.write(`${JSON.stringify(line)}\n`);
  };
  return {
    debug: (msg, f) => write('debug', msg, f),
    info: (msg, f) => write('info', msg, f),
    warn: (msg, f) => write('warn', msg, f),
    error: (msg, f) => write('error', msg, f),
  };
}
