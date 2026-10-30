// Sanitización de contenido dinámico y validación de plantillas editables.

import sanitizeHtml from 'sanitize-html';

// HTML permitido dentro de campos como `message` o `body`: formato de texto,
// listas, enlaces y tablas simples. Sin scripts, iframes, formularios ni handlers.
const MESSAGE_OPTIONS = {
  allowedTags: [
    'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'small', 'span', 'a', 'ul', 'ol', 'li',
    'h2', 'h3', 'h4', 'blockquote', 'code', 'pre', 'hr', 'img',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
  ],
  allowedAttributes: {
    a: ['href', 'title', 'target', 'rel'],
    img: ['src', 'alt', 'width', 'height'],
    td: ['align', 'colspan'], th: ['align', 'colspan'],
    '*': ['style'],
  },
  allowedStyles: {
    '*': {
      color: [/^#[0-9a-f]{3,8}$/i, /^rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)$/i],
      'text-align': [/^(left|right|center|justify)$/],
      'font-weight': [/^(normal|bold|[1-9]00)$/],
      'font-style': [/^(normal|italic)$/],
      'text-decoration': [/^(none|underline|line-through)$/],
    },
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesByTag: { img: ['https', 'data'] },
  allowProtocolRelative: false,
  transformTags: {
    a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer' } }),
  },
};

export function sanitizeMessage(html) {
  if (html === undefined || html === null) return '';
  const str = String(html);
  // Texto plano: respeta saltos de línea convirtiéndolos en párrafos.
  if (!/<[a-z][\s\S]*>/i.test(str)) {
    const escaped = sanitizeHtml(str, { allowedTags: [], allowedAttributes: {} });
    return escaped
      .split(/\n{2,}/)
      .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
      .join('');
  }
  return sanitizeHtml(str, MESSAGE_OPTIONS);
}

// Solo URLs navegables seguras; cualquier otra cosa (javascript:, data:, …) se neutraliza.
export function safeUrl(value) {
  if (typeof value !== 'string') return '#';
  const v = value.trim();
  if (/^(https?:\/\/|mailto:|tel:)/i.test(v)) return v;
  return '#';
}

// Defensa en profundidad para plantillas editadas por API: los clientes de
// correo no ejecutan JS, pero rechazamos patrones peligrosos igualmente.
const FORBIDDEN_PATTERNS = [
  [/<\s*script\b/i, 'No se permiten etiquetas <script>'],
  [/<\s*(iframe|object|embed|applet|frame|frameset|base)\b/i, 'Etiqueta no permitida (iframe/object/embed/base)'],
  [/<\s*(form|input|textarea|button|select)\b/i, 'No se permiten formularios en correos'],
  [/<\s*meta[^>]+http-equiv\s*=\s*["']?refresh/i, 'No se permite meta refresh'],
  [/\son[a-z]+\s*=/i, 'No se permiten atributos de eventos (onclick, onload, …)'],
  [/(javascript|vbscript)\s*:/i, 'No se permiten URLs javascript:/vbscript:'],
  [/expression\s*\(/i, 'No se permite CSS expression()'],
];

export function findForbiddenMarkup(source) {
  for (const [re, message] of FORBIDDEN_PATTERNS) if (re.test(source)) return message;
  return null;
}
