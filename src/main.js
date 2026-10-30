import 'dotenv/config';
import { createApp } from './app.js';
import { checkConfig, loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createMailer } from './mail/mailer.js';
import { createQueue } from './queue.js';
import { createEngine, loadBuiltins } from './templates/engine.js';
import { iconLoadError, iconsAvailable } from './templates/icon-render.js';
import { createStore } from './templates/store.js';

const config = loadConfig();
const logger = createLogger({ level: config.logLevel });

const { errors, warnings } = checkConfig(config);
for (const problem of warnings) logger.warn('config.warning', { problem });
if (errors.length) {
  for (const problem of errors) logger.error('config.invalid', { problem });
  throw new Error(`configuración inválida: ${errors.join(' ')} Revisa el archivo .env (ver .env.sample).`);
}
if (!iconsAvailable()) {
  logger.warn('icons.unavailable', { problem: `Íconos desactivados: ${iconLoadError()}. Ejecuta "npm ci" en este servidor para instalar el binario de @resvg/resvg-js de esta plataforma.` });
}

const builtins = await loadBuiltins(config.templatesDir);
const store = await createStore({ dataDir: config.dataDir, builtins, defaultBrand: config.brand });
const engine = createEngine({ store, icons: config.icons, legacy: { fromName: config.mail.fromName, fromEmail: config.mail.fromEmail } });
const mailer = createMailer(config, logger);
const queue = createQueue(config.queue, logger);
const app = createApp({ config, logger, mailer, queue, store, engine });

const server = app.listen(config.port, () => {
  logger.info('server.started', { url: `http://localhost:${config.port}`, docs: config.features.docs ? '/docs' : 'off', transport: config.mail.transport });
});
server.on('error', (err) => {
  const reason = err.code === 'EADDRINUSE' ? `el puerto ${config.port} ya está en uso (¿otra instancia corriendo?)` : err.message;
  console.log(`[mail-service] NO SE PUDO ARRANCAR: ${reason}`);
  logger.error('server.listen_failed', { error: reason });
  process.exit(1);
});
server.headersTimeout = 30_000;
server.requestTimeout = 60_000;
server.keepAliveTimeout = 10_000;

// Apagado ordenado: deja de aceptar conexiones, termina los envíos en curso y cierra SMTP.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('server.stopping', { signal });
  server.close();
  const { abandoned } = await queue.stop({ timeoutMs: 20_000 });
  if (abandoned) logger.warn('queue.abandoned', { jobs: abandoned });
  await store.flush();
  mailer.close();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => logger.error('unhandledRejection', { error: err?.message }));
