# Mail Service (Node.js + Gmail)

API para enviar correos usando Gmail con plantillas HTML (Handlebars) y seguridad por `x-api-key`.

## Requisitos
- Node.js 18+
- Cuenta de Gmail con App Password (recomendado)

### App Password en Gmail
1. Activa la verificación en dos pasos.
2. En tu cuenta Google → Seguridad → Contraseñas de aplicaciones.
3. Genera un App Password para "Correo" y "Otro".
4. Guarda el valor y ponlo en `GMAIL_PASS`.

## Configuración
1. Copia `.env.sample` a `.env` y edita valores.

```
API_KEY=pon-tu-api-key-segura-aqui
GMAIL_USER=tu_email@gmail.com
GMAIL_PASS=tu_app_password_de_gmail
MAIL_FROM_NAME=Tu Servicio
MAIL_FROM_EMAIL=tu_email@gmail.com
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
