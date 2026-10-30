// Cola en memoria con worker(s) y almacén de estado de jobs.
// Permite responder 202 al instante y procesar el envío en segundo plano,
// sin bloquear la UI del cliente.
//
// - Cada job guarda la llave que lo creó: solo ella (o un admin) puede consultarlo.
// - Idempotency-Key: reintentar la misma petición devuelve el mismo job.
// - El payload (PDF/XML en base64, datos personales) se borra al terminar.
//
// NOTA: es una cola en memoria (se pierde al reiniciar el proceso). Para
// producción con durabilidad/reintentos persistentes considera BullMQ + Redis.

import { randomUUID } from 'node:crypto';

export function createQueue({ concurrency = 5, maxAttempts = 3, retryBaseMs = 2000, jobTtlMs = 30 * 60 * 1000, maxPending = 5000 } = {}, logger) {
  const pending = [];          // jobs en espera (FIFO)
  const jobs = new Map();      // jobId -> job
  const idempotency = new Map(); // `${owner}:${key}` -> jobId
  const handlers = new Map();  // type -> async (payload, job) => result
  const counters = { sent: 0, failed: 0, retried: 0 };
  let active = 0;
  let stopping = false;
  const timers = new Set();

  const now = () => new Date().toISOString();
  const touch = (job, patch) => Object.assign(job, patch, { updatedAt: now() });

  function later(fn, ms) {
    const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
    t.unref?.();
    timers.add(t);
  }

  function scheduleCleanup(job) {
    later(() => {
      jobs.delete(job.id);
      if (job.idempotencyKey) idempotency.delete(`${job.owner}:${job.idempotencyKey}`);
    }, jobTtlMs);
  }

  function setHandler(type, fn) {
    handlers.set(type, fn);
  }

  function enqueue(type, payload, { owner = null, idempotencyKey = null, meta = {} } = {}) {
    if (idempotencyKey) {
      const existing = jobs.get(idempotency.get(`${owner}:${idempotencyKey}`));
      if (existing) return { job: existing, duplicate: true };
    }
    if (stopping) throw Object.assign(new Error('La cola se está deteniendo'), { code: 'QUEUE_STOPPING' });
    if (pending.length >= maxPending) throw Object.assign(new Error('Cola llena'), { code: 'QUEUE_FULL' });

    const job = {
      id: randomUUID(),
      type,
      payload,
      owner,
      idempotencyKey,
      meta,
      status: 'queued', // queued | processing | sent | failed
      attempts: 0,
      maxAttempts,
      result: null,
      error: null,
      createdAt: now(),
      updatedAt: now(),
    };
    jobs.set(job.id, job);
    if (idempotencyKey) idempotency.set(`${owner}:${idempotencyKey}`, job.id);
    pending.push(job);
    drain();
    return { job, duplicate: false };
  }

  const getJob = (id) => jobs.get(id) || null;

  function listJobs({ owner, status, limit = 50 } = {}) {
    const out = [];
    for (const job of [...jobs.values()].reverse()) {
      if (owner && job.owner !== owner) continue;
      if (status && job.status !== status) continue;
      out.push(job);
      if (out.length >= limit) break;
    }
    return out;
  }

  const stats = () => ({ pending: pending.length, active, total: jobs.size });
  const metrics = () => ({ ...stats(), ...counters, concurrency });

  function drain() {
    while (!stopping && active < concurrency && pending.length > 0) {
      const job = pending.shift();
      active++;
      runJob(job).finally(() => {
        active--;
        drain();
      });
    }
  }

  async function runJob(job) {
    const handler = handlers.get(job.type);
    if (!handler) {
      touch(job, { status: 'failed', error: 'No handler registrado', payload: null });
      return;
    }
    job.attempts++;
    touch(job, { status: 'processing' });
    try {
      const result = await handler(job.payload, job);
      touch(job, { status: 'sent', result, error: null, payload: null });
      counters.sent++;
      scheduleCleanup(job);
    } catch (err) {
      const message = err?.message || String(err);
      // Errores de validación (4xx) no se arreglan reintentando.
      const permanent = err?.status >= 400 && err?.status < 500;
      if (!permanent && job.attempts < job.maxAttempts && !stopping) {
        // Reintento con backoff exponencial.
        const delay = retryBaseMs * 2 ** (job.attempts - 1);
        touch(job, { status: 'queued', error: `intento ${job.attempts} falló: ${message}` });
        counters.retried++;
        later(() => {
          pending.push(job);
          drain();
        }, delay);
      } else {
        touch(job, { status: 'failed', error: message, payload: null });
        counters.failed++;
        logger?.warn('queue.job_failed', { jobId: job.id, type: job.type, attempts: job.attempts, error: message });
        scheduleCleanup(job);
      }
    }
  }

  // Apagado ordenado: deja de tomar trabajo y espera a los jobs en curso.
  async function stop({ timeoutMs = 15_000 } = {}) {
    stopping = true;
    const deadline = Date.now() + timeoutMs;
    while (active > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    for (const t of timers) clearTimeout(t);
    timers.clear();
    return { abandoned: pending.length + active };
  }

  return { setHandler, enqueue, getJob, listJobs, stats, metrics, stop };
}
