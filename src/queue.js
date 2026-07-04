// Cola en memoria simple con worker(s) y almacén de estado de jobs.
// Permite responder 202 al instante y procesar el envío en segundo plano,
// sin bloquear la UI del cliente.
//
// NOTA: es una cola en memoria (se pierde al reiniciar el proceso). Para
// producción con durabilidad/reintentos persistentes considera BullMQ + Redis.

import { randomUUID } from 'node:crypto';

const CONCURRENCY = Number(process.env.QUEUE_CONCURRENCY || 5);
const MAX_ATTEMPTS = Number(process.env.QUEUE_MAX_ATTEMPTS || 3);
const RETRY_BASE_MS = Number(process.env.QUEUE_RETRY_BASE_MS || 2000);
// Tiempo que se conserva un job terminado antes de limpiarlo (para consultas de estado).
const JOB_TTL_MS = Number(process.env.QUEUE_JOB_TTL_MS || 30 * 60 * 1000);

const pending = [];           // jobs en espera (FIFO)
const jobs = new Map();       // jobId -> job (estado consultable)
let active = 0;
let handler = null;           // función que procesa cada job: async (payload) => result

export function setHandler(fn) {
  handler = fn;
}

export function enqueue(type, payload) {
  const job = {
    id: randomUUID(),
    type,
    payload,
    status: 'queued',        // queued | processing | sent | failed
    attempts: 0,
    maxAttempts: MAX_ATTEMPTS,
    result: null,
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  jobs.set(job.id, job);
  pending.push(job);
  drain();
  return job;
}

export function getJob(id) {
  return jobs.get(id) || null;
}

export function stats() {
  return { pending: pending.length, active, total: jobs.size };
}

function touch(job, patch) {
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
}

function scheduleCleanup(job) {
  setTimeout(() => jobs.delete(job.id), JOB_TTL_MS).unref?.();
}

function drain() {
  while (active < CONCURRENCY && pending.length > 0) {
    const job = pending.shift();
    active++;
    runJob(job).finally(() => {
      active--;
      drain();
    });
  }
}

async function runJob(job) {
  if (!handler) {
    touch(job, { status: 'failed', error: 'No handler registrado' });
    return;
  }
  job.attempts++;
  touch(job, { status: 'processing' });
  try {
    const result = await handler(job.payload, job);
    touch(job, { status: 'sent', result });
    scheduleCleanup(job);
  } catch (err) {
    const message = err?.message || String(err);
    if (job.attempts < job.maxAttempts) {
      // Reintento con backoff exponencial.
      const delay = RETRY_BASE_MS * 2 ** (job.attempts - 1);
      touch(job, { status: 'queued', error: `intento ${job.attempts} falló: ${message}` });
      setTimeout(() => {
        pending.push(job);
        drain();
      }, delay).unref?.();
    } else {
      touch(job, { status: 'failed', error: message });
      scheduleCleanup(job);
    }
  }
}
