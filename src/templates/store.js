// Almacén de plantillas editables y branding, con historial de versiones.
//
// - Las plantillas incluidas (builtin) viven en src/templates y son de solo lectura.
// - Lo creado/editado por API se guarda en DATA_DIR/store.json y tiene prioridad
//   sobre la builtin del mismo nombre (override). Borrar el override la restaura.
// - Escritura atómica (archivo temporal + rename) y serializada, permisos 0600.
// - Auditoría append-only en DATA_DIR/audit.log (quién, qué, cuándo).

import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';

export const KINDS = ['email', 'layout', 'partial'];
const MAX_VERSIONS = 50;

const emptyData = () => ({ schemaVersion: 1, templates: { email: {}, layout: {}, partial: {} }, branding: {} });

export async function createStore({ dataDir, builtins, defaultBrand }) {
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, 'store.json');
  const auditFile = path.join(dataDir, 'audit.log');
  const events = new EventEmitter();

  let data = emptyData();
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    data = { ...emptyData(), ...parsed, templates: { ...emptyData().templates, ...parsed.templates } };
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`No se pudo leer ${file}: ${err.message}`);
  }

  let writing = Promise.resolve();
  function persist() {
    const snapshot = JSON.stringify(data, null, 2);
    writing = writing.then(async () => {
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, snapshot, { mode: 0o600 });
      await fs.rename(tmp, file);
    });
    return writing;
  }

  async function audit(entry) {
    const line = JSON.stringify({ time: new Date().toISOString(), ...entry });
    await fs.appendFile(auditFile, `${line}\n`, { mode: 0o600 });
  }

  const custom = (kind, name) => data.templates[kind]?.[name];
  const builtin = (kind, name) => builtins[kind]?.[name];

  function view(kind, name) {
    const c = custom(kind, name);
    const b = builtin(kind, name);
    if (!c && !b) return null;
    if (c) {
      const v = c.versions.at(-1);
      return {
        name, kind, source: 'custom', builtin: Boolean(b), version: v.version,
        html: v.html, subject: v.subject, description: v.description,
        layout: v.layout, sampleData: v.sampleData ?? b?.sampleData ?? {},
        updatedAt: v.createdAt, updatedBy: v.createdBy,
      };
    }
    return {
      name, kind, source: 'builtin', builtin: true, version: 0,
      html: b.html, subject: b.subject, description: b.description,
      layout: b.layout, sampleData: b.sampleData ?? {}, updatedAt: null, updatedBy: null,
    };
  }

  function list(kind) {
    const names = new Set([...Object.keys(builtins[kind] || {}), ...Object.keys(data.templates[kind] || {})]);
    return [...names].sort().map((name) => {
      const { html, sampleData, ...meta } = view(kind, name);
      return { ...meta, overridden: meta.builtin && meta.source === 'custom' };
    });
  }

  async function save(kind, name, fields, { actor, expectedVersion } = {}) {
    const current = view(kind, name);
    if (expectedVersion !== undefined && (current?.version ?? -1) !== expectedVersion) {
      const err = new Error('La plantilla cambió desde que la leíste');
      err.code = 'VERSION_CONFLICT';
      err.currentVersion = current?.version ?? null;
      throw err;
    }
    const entry = data.templates[kind][name] || (data.templates[kind][name] = { versions: [] });
    const last = entry.versions.at(-1);
    const version = {
      version: (last?.version ?? 0) + 1,
      html: fields.html,
      subject: fields.subject,
      description: fields.description,
      layout: fields.layout,
      sampleData: fields.sampleData,
      createdAt: new Date().toISOString(),
      createdBy: actor,
      note: fields.note,
    };
    entry.versions.push(version);
    if (entry.versions.length > MAX_VERSIONS) entry.versions.splice(0, entry.versions.length - MAX_VERSIONS);
    await persist();
    await audit({ actor, action: current ? 'template.update' : 'template.create', kind, name, version: version.version });
    events.emit('change', { kind, name });
    return view(kind, name);
  }

  async function remove(kind, name, { actor } = {}) {
    if (!custom(kind, name)) return false;
    delete data.templates[kind][name];
    await persist();
    await audit({ actor, action: 'template.delete', kind, name });
    events.emit('change', { kind, name });
    return true;
  }

  function versions(kind, name) {
    return (custom(kind, name)?.versions || []).map(({ html, sampleData, ...meta }) => meta).reverse();
  }

  const getVersion = (kind, name, version) => custom(kind, name)?.versions.find((v) => v.version === version) || null;

  const getBranding = () => ({ ...defaultBrand, ...data.branding });

  async function setBranding(patch, { actor } = {}) {
    data.branding = { ...data.branding, ...patch };
    await persist();
    await audit({ actor, action: 'branding.update', fields: Object.keys(patch) });
    events.emit('change', { kind: 'branding' });
    return getBranding();
  }

  async function readAudit(limit = 100) {
    try {
      const lines = (await fs.readFile(auditFile, 'utf8')).trim().split('\n');
      return lines.slice(-limit).reverse().map((l) => JSON.parse(l));
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  return {
    view, list, save, remove, versions, getVersion, getBranding, setBranding, readAudit,
    on: (...args) => events.on(...args),
    flush: () => writing,
  };
}
