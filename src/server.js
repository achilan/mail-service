// Punto de entrada con diagnóstico de arranque. Si algo impide iniciar
// (Node viejo, dependencias sin instalar, configuración inválida) se explica
// en stdout Y stderr, para que se vea en `pm2 logs` sin importar qué log mires.

function fatal(message) {
  const line = `[mail-service] NO SE PUDO ARRANCAR: ${message}`;
  console.log(line);
  console.error(line);
  process.exit(1);
}

const [major] = process.versions.node.split('.').map(Number);
if (major < 20) {
  fatal(`Node ${process.versions.node} no es compatible; se requiere Node 20 o superior.`);
}

try {
  await import('./main.js');
} catch (err) {
  if (err?.code === 'ERR_MODULE_NOT_FOUND' || err?.code === 'MODULE_NOT_FOUND') {
    fatal(`falta una dependencia (${err.message.split('\n')[0]}). Ejecuta "npm ci" en el servidor (no copies node_modules desde otra máquina).`);
  }
  fatal(err?.stack || String(err));
}
