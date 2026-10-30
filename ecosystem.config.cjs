// Configuración de pm2:  pm2 start ecosystem.config.cjs  (y luego: pm2 save)
module.exports = {
  apps: [
    {
      name: 'xmail',
      script: 'src/server.js',
      cwd: __dirname,
      // Requiere Node >= 20. Si el servidor tiene otras apps en una versión vieja,
      // apunta solo esta app a su propio binario: XMAIL_NODE=$(nvm which 22) pm2 start ...
      interpreter: process.env.XMAIL_NODE || 'node',
      instances: 1, // la cola es en memoria: no usar cluster
      exec_mode: 'fork',
      env: { NODE_ENV: 'production' },
      max_memory_restart: '512M',
      kill_timeout: 25_000, // da tiempo al apagado ordenado (termina envíos en curso)
      restart_delay: 3_000,
      max_restarts: 10,
      time: true,
    },
  ],
};
