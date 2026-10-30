// Renderiza íconos Material Symbols como SVG (navegador) o PNG (correo).
// Gmail y Outlook no muestran SVG, así que en los correos se incrustan como
// PNG a 2x (nítidos en pantallas retina) referenciados por `cid:`.

import { ICONS } from './icons.js';

// @resvg/resvg-js es un binario nativo por plataforma. Si falta (p. ej. node_modules
// copiado desde otro sistema operativo) el servicio sigue funcionando sin íconos.
let Resvg = null;
let loadError = null;
try {
  ({ Resvg } = await import('@resvg/resvg-js'));
} catch (err) {
  loadError = err?.message?.split('\n')[0] || String(err);
}

export const iconsAvailable = () => Boolean(Resvg);
export const iconLoadError = () => loadError;

const HEX = /^#?([0-9a-f]{6})$/i;
const cache = new Map();
const MAX_CACHE = 500;

export const hasIcon = (name) => Object.hasOwn(ICONS, name);
export const iconNames = () => Object.keys(ICONS);

export function normalizeColor(color, fallback = '667085') {
  const m = HEX.exec(String(color || ''));
  return (m ? m[1] : fallback).toUpperCase();
}

export function iconSvg(name, color, size = 24) {
  const d = ICONS[hasIcon(name) ? name : 'mail'];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 -960 960 960"><path fill="#${normalizeColor(color)}" d="${d}"/></svg>`;
}

// PNG con caché en memoria (las combinaciones ícono/color/tamaño son pocas).
export function iconPng(name, color, size = 24) {
  if (!Resvg) return null;
  const px = Math.min(Math.max(Math.round(size), 8), 128) * 2;
  const key = `${name}:${normalizeColor(color)}:${px}`;
  let png = cache.get(key);
  if (!png) {
    png = new Resvg(iconSvg(name, color, px), { fitTo: { mode: 'width', value: px } }).render().asPng();
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
    cache.set(key, png);
  }
  return png;
}
