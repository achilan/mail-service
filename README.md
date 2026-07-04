# Mail Service (Node.js + SMTP)

API para enviar correos por SMTP (ej. Hostinger) con plantillas HTML (Handlebars) y seguridad por `x-api-key`.

## Requisitos
- Node.js 18+
- Un buzón de correo con acceso SMTP (ej. Hostinger, Gmail, etc.)

### Datos SMTP de Hostinger
- Host: `smtp.hostinger.com`
- Puerto: `465` (SSL) o `587` (STARTTLS)
- Usuario: la dirección completa del buzón (ej. `tucorreo@tudominio.com`)
- Contraseña: la del buzón (la que definiste al crear la cuenta en Hostinger)

## Configuración
1. Copia `.env.sample` a `.env` y edita valores.

```
API_KEY=pon-tu-api-key-segura-aqui
SMTP_HOST=smtp.hostinger.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=tucorreo@tudominio.com
SMTP_PASS=la_contraseña_del_buzón
MAIL_FROM_NAME=Tu Servicio
MAIL_FROM_EMAIL=tucorreo@tudominio.com
PORT=3000
```

2. Instala dependencias y ejecuta:

```bash
npm install
npm run dev
```

Servidor en: http://localhost:3000

## Endpoints

- POST `/send`
  - Body:
    ```json
    {
      "to": "destino@correo.com",
      "subject": "Asunto",
      "template": "generic",
      "context": { "title": "Hola", "message": "Mundo" }
    }
    ```
  - Headers: `x-api-key: <API_KEY>`

- POST `/notify/login-success`
  - Body:
    ```json
    { "to": "destino@correo.com", "userName": "Anthony" }
    ```

- POST `/notify/new-order`
  - Body:
    ```json
    {
      "to": "destino@correo.com",
      "orderId": "A-001",
      "orderTotal": 123.45,
      "items": [ { "name": "Producto", "qty": 2, "price": 10 } ]
    }
    ```

- POST `/notify/custom`
  - Body:
    ```json
    {
      "to": "destino@correo.com",
      "title": "Notificación",
      "message": "Tu acción fue exitosa",
      "ctaUrl": "https://tuapp.com",
      "ctaText": "Ver detalle"
    }
    ```

## Envío de documentos electrónicos (RIDE) — con cola

Envía el PDF (RIDE) de un comprobante electrónico — factura, nota de crédito, retención, etc.
El envío se **encola** y el endpoint responde `202` al instante con un `jobId`, por lo que **no bloquea la UI**. El correo se procesa en segundo plano (con reintentos y backoff).

Tipos válidos en `tipoDocumento`: `factura`, `nota_credito`, `nota_debito`, `retencion`, `guia_remision`, `liquidacion`.

### POST `/documents/send` → encola y devuelve `202`

Headers: `x-api-key: <API_KEY>`

```json
{
  "to": "cliente@correo.com",
  "cc": ["copia@correo.com"],
  "bcc": ["archivo@miempresa.com"],
  "destinatarioNombre": "Juan Pérez",
  "tipoDocumento": "factura",
  "documento": {
    "numero": "001-001-000000123",
    "claveAcceso": "0606202601179...",
    "fechaEmision": "2026-06-06",
    "razonSocialEmisor": "Mi Empresa S.A.",
    "total": "123.45"
  },
  "adjuntos": {
    "pdfBase64": "JVBERi0xLjQK...",
    "xmlBase64": "PD94bWwg..."
  }
}
```

- El PDF es obligatorio: usa `adjuntos.pdfBase64` **o** `adjuntos.pdfUrl` (el servicio lo descarga).
- El XML es opcional: `adjuntos.xmlBase64` o `adjuntos.xmlUrl`.
- `subject` es opcional; si no lo envías se genera automáticamente.

Respuesta:

```json
{ "ok": true, "jobId": "100fe417-d7b1-41f7-a1b8-9c1f4371eb4f", "status": "queued" }
```

### GET `/jobs/:id` → estado del envío (polling desde la UI)

```json
{ "ok": true, "jobId": "...", "status": "sent", "attempts": 1, "result": { "messageId": "<...>" }, "error": null }
```

`status`: `queued` → `processing` → `sent` | `failed`.

### GET `/queue/stats` → métricas de la cola

```json
{ "ok": true, "pending": 0, "active": 1, "total": 3 }
```

### Variables de entorno opcionales de la cola

```
QUEUE_CONCURRENCY=2        # envíos en paralelo
QUEUE_MAX_ATTEMPTS=3       # reintentos por job
QUEUE_RETRY_BASE_MS=2000   # backoff exponencial base
QUEUE_JOB_TTL_MS=1800000   # tiempo que se conserva un job terminado (30 min)
JSON_LIMIT=25mb            # tamaño máximo del body (PDF en base64)
```

> La cola es **en memoria**: simple y sin dependencias, pero se pierde al reiniciar. Para producción con durabilidad real usa **BullMQ + Redis**.

### Ejemplo de consumo desde la UI (no bloqueante)

```js
// 1) Encolar — vuelve enseguida, la UI sigue libre
const { jobId } = await fetch('/documents/send', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
  body: JSON.stringify({ to, tipoDocumento: 'factura', documento, adjuntos: { pdfBase64 } }),
}).then(r => r.json());

// 2) Polling del estado (opcional)
const poll = setInterval(async () => {
  const job = await fetch(`/jobs/${jobId}`, { headers: { 'x-api-key': API_KEY } }).then(r => r.json());
  if (job.status === 'sent' || job.status === 'failed') {
    clearInterval(poll);
    // actualizar UI según job.status
  }
}, 2000);
```

## Pruebas rápidas

```bash
# Salud
curl -s http://localhost:3000/health | jq

# Envío genérico
curl -s -X POST http://localhost:3000/send \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{
    "to":"destino@correo.com",
    "subject":"Hola",
    "template":"generic",
    "context": {"title":"Bienvenido","message":"Gracias por registrarte"}
  }' | jq
```

## Notas
- Usa App Password para evitar bloqueos de Gmail.
- Si deseas OAuth2, puedo añadirlo.
