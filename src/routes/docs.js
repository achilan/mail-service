// Documentación: especificación OpenAPI en /openapi.json y Swagger UI en /docs.
// Swagger UI se sirve desde el paquete local (sin CDN) y con CSP estricta.

import { createRequire } from 'node:module';
import path from 'node:path';
import express, { Router } from 'express';
import { buildOpenApi } from '../openapi.js';

const require = createRequire(import.meta.url);

const PAGE = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Mail Service · API</title>
  <link rel="stylesheet" href="/docs/assets/swagger-ui.css">
  <link rel="stylesheet" href="/docs/theme.css">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="/docs/assets/swagger-ui-bundle.js"></script>
  <script src="/docs/init.js"></script>
</body>
</html>`;

const INIT = `window.ui = SwaggerUIBundle({
  url: '/openapi.json',
  dom_id: '#swagger-ui',
  deepLinking: true,
  persistAuthorization: false,
  displayRequestDuration: true,
  tryItOutEnabled: false,
  filter: true,
  docExpansion: 'list',
  defaultModelsExpandDepth: 0,
  syntaxHighlight: { theme: 'nord' },
});`;

const THEME = `
body{margin:0;background:#F9FAFB;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
.swagger-ui .topbar{display:none}
.swagger-ui .info{margin:40px 0 24px}
.swagger-ui .info .title{font-size:32px;letter-spacing:-.02em;color:#101828}
.swagger-ui .scheme-container{box-shadow:none;border:1px solid #EAECF0;border-radius:16px;margin:0 0 24px;padding:20px}
.swagger-ui .opblock{border-radius:12px;box-shadow:none}
.swagger-ui .opblock-tag{border-bottom:1px solid #EAECF0}
.swagger-ui .btn.authorize{border-color:#4F46E5;color:#4F46E5;border-radius:10px}
.swagger-ui .btn.authorize svg{fill:#4F46E5}
.swagger-ui .wrapper{max-width:1200px;padding:0 16px}
`;

export function docsRouter({ config }) {
  const router = Router();
  const spec = buildOpenApi(config);
  const assetsDir = path.dirname(require.resolve('swagger-ui-dist/package.json'));
  const csp = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

  router.get('/openapi.json', (req, res) => res.json(spec));

  router.use('/docs/assets', express.static(assetsDir, {
    index: false,
    immutable: true,
    maxAge: '7d',
    setHeaders: (res) => res.set('Content-Security-Policy', csp),
  }));
  router.get('/docs/init.js', (req, res) => res.type('application/javascript').send(INIT));
  router.get('/docs/theme.css', (req, res) => res.type('text/css').send(THEME));
  router.get(['/docs', '/docs/'], (req, res) => res.set('Content-Security-Policy', csp).type('html').send(PAGE));

  return router;
}
