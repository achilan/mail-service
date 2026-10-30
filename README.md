# Mail Service

API para enviar correos por SMTP con **plantillas HTML profesionales editables por API**, adjuntos (RIDE PDF/XML), cola asíncrona con reintentos y seguridad de nivel producción.

- **Documentación interactiva (Swagger UI):** `GET /docs` · especificación OpenAPI 3.1 en `GET /openapi.json`
- **Galería de plantillas:** `GET /preview` · una plantilla: `GET /preview/:template`

## Inicio rápido

```bash
cp .env.sample .env      # edita API_KEY y SMTP_*
npm install
npm run dev              # http://localhost:3000/docs
```

Para probar sin enviar correos reales: `MAIL_TRANSPORT=json npm run dev`.

```bash
npm test                 # 86 tests: seguridad, contratos heredados, API de plantillas, render
npm run build && npm start
```

Docker:

```bash
docker build -t mail-service .
docker run -p 3000:3000 --env-file .env -v mail-data:/data mail-service
```

## Seguridad

| Capa | Qué hace |
|---|---|
| Autenticación | `x-api-key` o `Authorization: Bearer`. Comparación en tiempo constante. El servicio **no arranca** sin llaves configuradas. |
| Permisos (scopes) | Llaves con mínimo privilegio vía `API_KEYS`: `mail:send`, `mail:send:raw`, `templates:read`, `templates:write`, `admin`, `*`. |
| Rate limiting | Por llave (general y envíos) y bloqueo de fuerza bruta de llaves por IP. |
| Validación | Destinatarios (formato, cantidad, dominios permitidos), asunto sin saltos de línea (anti header-injection), schemas zod en v1. |
| XSS | `message`/`body` se sanitizan; URLs `javascript:` se neutralizan; las plantillas editadas rechazan `<script>`, `on*=`, iframes y formularios. |
| Handlebars | Entorno aislado, solo helpers conocidos, sin acceso a prototipos. Nombres de plantilla en lista blanca (sin path traversal). |
| SSRF | Adjuntos por URL: IPs privadas/loopback/metadata bloqueadas al conectar (anti DNS-rebinding), redirecciones revalidadas, tamaño y timeout limitados. |
| Adjuntos | Solo tipos permitidos (pdf, xml, imágenes, csv, txt, ics, zip, xlsx, docx), nombres saneados, sin acceso a archivos del servidor. |
| Jobs | Cada job solo es visible para la llave que lo creó; el payload (PDF, datos personales) se borra al terminar. |
| Cabeceras | Helmet (CSP, nosniff, HSTS en producción, frame-ancestors), `Cache-Control: no-store`, `X-Request-Id`. |
| SMTP | TLS ≥ 1.2 con verificación de certificado; STARTTLS obligatorio en 587; DKIM opcional. |
| Logs | JSON estructurado; secretos, cuerpos y adjuntos redactados. |
| Auditoría | Cada cambio de plantilla/branding queda en `DATA_DIR/audit.log` (quién, qué, cuándo). |
| Cadena de suministro | Dependencias con versión exacta, `package-lock.json` versionado, CI con `npm audit` y permisos de solo lectura. |

## Plantillas incluidas

`generic` · `notification` · `login-success` · `new-order` · `document` · `welcome` · `password-reset` · `otp-code` · `event-ticket`

Diseño responsive con modo oscuro, compatible con Gmail, Apple Mail y Outlook (botones a prueba de Outlook, tablas, preheader), versión de texto plano automática e íconos **Material Symbols** de Google, que se incrustan como PNG nítidos (`cid:`) para que se vean en todos los clientes.

## API v1

### Enviar (asíncrono, con cola)

```bash
curl -X POST http://localhost:3000/v1/emails \
  -H "x-api-key: $API_KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: otp-ana-001" \
  -d '{
    "to": "ana@correo.com",
    "template": "otp-code",
    "context": { "code": "482913", "userName": "Ana", "purpose": "verificar tu correo" }
  }'
# → 202 { "ok": true, "jobId": "…", "status": "queued" }
```

Campos: `to`, `cc`, `bcc`, `replyTo`, `subject` (opcional: cada plantilla tiene asunto por defecto), `template`, `context`, `preheader`, `attachments[]` (`filename` + `contentBase64` o `url`), `headers` (solo `X-*`), `unsubscribeUrl`, `tags`.

También: `POST /v1/emails/batch` (hasta 100, todo o nada), `POST /v1/emails/render` (renderiza sin enviar), `GET /v1/jobs`, `GET /v1/jobs/:id`.

### Editar plantillas por API

Mismo patrón para `/v1/templates`, `/v1/layouts` y `/v1/partials`:

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/v1/templates` | Listar (incluidas + personalizadas) |
| GET | `/v1/templates/:name` | Código fuente, versión (`ETag`) y variables |
| PUT | `/v1/templates/:name` | Crear o reemplazar (nueva versión) |
| PATCH | `/v1/templates/:name` | Cambiar solo algunos campos |
| DELETE | `/v1/templates/:name` | Borrar la versión personalizada (restaura la original si existe) |
| GET | `/v1/templates/:name/versions` | Historial |
| POST | `/v1/templates/:name/rollback` | Volver a una versión (`{ "version": 2 }`) |
| POST | `/v1/templates/:name/preview` | Previsualizar (`format: "json" \| "html"`) |
| POST | `/v1/templates/validate` | Validar código sin guardarlo |

Antes de guardar se valida la sintaxis, los helpers, el marcado peligroso y un render de prueba con `sampleData`. Envía `If-Match: "<versión>"` para evitar pisar cambios ajenos (409 si cambió).

```bash
curl -X PUT http://localhost:3000/v1/templates/reporte-mensual \
  -H "x-api-key: $EDITOR_KEY" -H "Content-Type: application/json" \
  -d '{
    "subject": "Tu reporte de {{mes}} está listo",
    "html": "{{> hero icon=\"analytics\" tone=\"success\" eyebrow=\"Reportes\" title=\"Tu reporte está listo\"}}<div class=\"em-content\">{{{safe message}}}</div>{{> button url=ctaUrl text=\"Ver reporte\"}}{{> signature}}",
    "sampleData": { "mes": "octubre", "message": "Ya puedes revisar las métricas.", "ctaUrl": "https://example.com" }
  }'
```

**Helpers:** `safe`, `safeUrl`, `icon`, `formatMoney`, `formatDate`, `fallback`, `eq`, `ne`, `gt`, `and`, `or`, `not`, `upper`, `multiply`, `inc`, `toneColor`, `tintColor`, `initialOf`, `currentYear`.

**Partials:** `hero`, `button`, `panel`, `row`, `details`, `callout`, `code`, `divider`, `signature`, `fineprint`.

**Íconos:** `{{icon "shield_lock" "#4F46E5" 24}}` o `{{> hero icon="shield_lock"}}`. Lista completa en `GET /v1/icons`.

**Tonos:** `brand`, `success`, `info`, `warning`, `danger`, `neutral`.

### Branding

`GET /v1/branding` · `PUT /v1/branding` (admin): `name`, `logoUrl`, `primaryColor`, `accentColor`, `website`, `supportEmail`, `address`, `footerNote`, `lang`, `socialLinks[]`. Se aplica al instante a todas las plantillas.

### Administración

`GET /v1/audit` (admin) · `GET /v1/stats` · `GET /health` · `GET /ready` (verifica SMTP).

## Endpoints heredados (sin cambios de contrato)

Mismas rutas, cuerpos y respuestas que la versión anterior: `POST /send`, `POST /notify/login-success`, `POST /notify/new-order`, `POST /notify/generic`, `POST /notify/custom`, `POST /send-html`, `POST /documents/send`, `GET /jobs/:id`, `GET /queue/stats`, `GET /preview/:template`. Todos están documentados en `/docs`.

### Documentos electrónicos (RIDE)

`POST /documents/send` encola y responde `202 { ok, jobId, status }`. Tipos válidos en `tipoDocumento`: `factura`, `nota_credito`, `nota_debito`, `retencion`, `guia_remision`, `liquidacion`, `cotizacion`, `general` (se aceptan tildes, mayúsculas y formas largas como "Nota de Crédito").

```json
{
  "to": "cliente@correo.com",
  "cc": ["copia@correo.com"],
  "destinatarioNombre": "Juan Pérez",
  "tipoDocumento": "factura",
  "documento": {
    "numero": "001-001-000000123",
    "claveAcceso": "0606202601179...",
    "fechaEmision": "2026-06-06",
    "razonSocialEmisor": "Mi Empresa S.A.",
    "total": "123.45"
  },
  "adjuntos": { "pdfBase64": "JVBERi0xLjQK...", "xmlBase64": "PD94bWwg..." }
}
```

El PDF es obligatorio (`adjuntos.pdfBase64` o `adjuntos.pdfUrl`); el XML es opcional. Consulta el estado con `GET /jobs/:id` (`queued` → `processing` → `sent` | `failed`). Envía `Idempotency-Key` para que un reintento no duplique el correo.

> La cola es en memoria: se pierde al reiniciar. Para durabilidad real usa BullMQ + Redis.

## Configuración

Todas las variables están documentadas en [.env.sample](.env.sample).
