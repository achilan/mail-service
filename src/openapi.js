// Especificación OpenAPI 3.1 del servicio. Se sirve en /openapi.json y en /docs.

import { CATALOG } from './templates/catalog.js';

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema, example) => ({ content: { 'application/json': { schema, ...(example ? { example } : {}) } } });
const ok = (description, schema, example) => ({ description, ...json(schema, example) });
const err = (description) => ({ description, ...json(ref('Error')) });

const common = {
  400: err('Datos inválidos'),
  401: err('API key ausente o inválida'),
  403: err('La API key no tiene el permiso necesario'),
  429: err('Demasiadas peticiones'),
};

const nameParam = { name: 'name', in: 'path', required: true, schema: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,63}$' } };
const ifMatch = { name: 'If-Match', in: 'header', required: false, description: 'Versión actual esperada (control de concurrencia). Si no coincide → 409.', schema: { type: 'string', example: '"3"' } };
const idempotency = { name: 'Idempotency-Key', in: 'header', required: false, description: 'Reintentar con la misma clave devuelve el mismo job en vez de duplicar el envío.', schema: { type: 'string', maxLength: 200 } };

function collectionPaths(collection, kind, label) {
  const tag = 'Plantillas';
  const base = `/v1/${collection}`;
  return {
    [base]: {
      get: { tags: [tag], summary: `Listar ${label}`, security: [{ ApiKey: [] }], responses: { 200: ok('Listado', ref('TemplateList')), ...common } },
    },
    [`${base}/{name}`]: {
      parameters: [nameParam],
      get: { tags: [tag], summary: `Obtener ${label.replace(/s$/, '')} (código fuente + metadatos)`, security: [{ ApiKey: [] }], responses: { 200: ok('Plantilla', ref('Template')), 404: err('No existe'), ...common } },
      put: {
        tags: [tag], summary: `Crear o reemplazar (${kind})`,
        description: 'Crea una versión nueva. Se valida sintaxis Handlebars, helpers permitidos, marcado peligroso y un render de prueba con `sampleData` antes de guardar. Si la plantilla es incluida, se crea una versión personalizada que tiene prioridad.',
        security: [{ ApiKey: [] }], parameters: [ifMatch],
        requestBody: { required: true, ...json(ref('TemplateWrite'), kind === 'email' ? {
          subject: 'Hola {{userName}}, tu reporte está listo',
          description: 'Reporte mensual',
          html: "{{> hero icon='analytics' tone='success' title='Tu reporte está listo'}}\n<div class=\"em-content\">{{{safe message}}}</div>\n{{> button url=ctaUrl text='Ver reporte'}}\n{{> signature}}",
          sampleData: { userName: 'Ana', message: 'Ya puedes revisar las métricas de octubre.', ctaUrl: 'https://example.com/r' },
        } : undefined) },
        responses: { 200: ok('Actualizada', ref('Template')), 201: ok('Creada', ref('Template')), 409: err('Conflicto de versión'), 422: err('La plantilla no compila o contiene marcado prohibido'), ...common },
      },
      patch: {
        tags: [tag], summary: 'Actualización parcial (solo los campos enviados)', security: [{ ApiKey: [] }], parameters: [ifMatch],
        requestBody: { required: true, ...json(ref('TemplatePatch')) },
        responses: { 200: ok('Actualizada', ref('Template')), 404: err('No existe'), 409: err('Conflicto de versión'), 422: err('Error de plantilla'), ...common },
      },
      delete: {
        tags: [tag], summary: 'Borrar versión personalizada (si era incluida, se restaura la original)', security: [{ ApiKey: [] }],
        responses: { 200: ok('Borrada', { type: 'object', properties: { ok: { type: 'boolean' }, deleted: { type: 'boolean' }, restoredBuiltin: { type: 'boolean' } } }), 404: err('No había versión personalizada'), ...common },
      },
    },
    [`${base}/{name}/versions`]: {
      parameters: [nameParam],
      get: { tags: [tag], summary: 'Historial de versiones', security: [{ ApiKey: [] }], responses: { 200: ok('Versiones', { type: 'object', properties: { versions: { type: 'array', items: ref('VersionMeta') } } }), ...common } },
    },
    [`${base}/{name}/versions/{version}`]: {
      parameters: [nameParam, { name: 'version', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } }],
      get: { tags: [tag], summary: 'Obtener una versión concreta', security: [{ ApiKey: [] }], responses: { 200: ok('Versión', ref('Template')), 404: err('No existe'), ...common } },
    },
    [`${base}/{name}/rollback`]: {
      parameters: [nameParam],
      post: {
        tags: [tag], summary: 'Restaurar una versión anterior (crea una versión nueva)', security: [{ ApiKey: [] }], parameters: [ifMatch],
        requestBody: { required: true, ...json({ type: 'object', required: ['version'], properties: { version: { type: 'integer', minimum: 1 } } }, { version: 2 }) },
        responses: { 200: ok('Restaurada', ref('Template')), 404: err('Versión no encontrada'), ...common },
      },
    },
  };
}

export function buildOpenApi(config) {
  const templateNames = Object.keys(CATALOG.email);
  return {
    openapi: '3.1.0',
    info: {
      title: 'Mail Service API',
      version: '2.0.0',
      description: [
        'API para enviar correos con plantillas HTML profesionales, adjuntos (RIDE/XML) y una cola asíncrona.',
        '',
        '**Autenticación:** header `x-api-key` (o `Authorization: Bearer <key>`). Cada llave tiene permisos (*scopes*):',
        '`mail:send`, `mail:send:raw`, `templates:read`, `templates:write`, `admin` o `*`.',
        '',
        '**Plantillas:** Handlebars con helpers `safe`, `safeUrl`, `icon`, `formatMoney`, `formatDate`, `fallback`, `eq`, `ne`, `gt`, `and`, `or`, `not`, `upper`, `multiply`, `inc`, `toneColor`, `tintColor`, `initialOf`, `currentYear`',
        'y partials `hero`, `button`, `panel`, `row`, `details`, `callout`, `code`, `divider`, `signature`, `fineprint`. El contexto siempre incluye `brand`, `subject`, `preheader` y `now`.',
        '',
        '**Íconos:** Material Symbols Rounded de Google: `{{icon "shield_lock" "#4F46E5" 24}}` o `{{> hero icon="shield_lock"}}`. En los correos se incrustan como PNG (cid) para que se vean en Gmail y Outlook. Lista en `GET /v1/icons`.',
        '',
        `Plantillas incluidas: ${templateNames.map((n) => `\`${n}\``).join(', ')}. Galería visual en [/preview](/preview).`,
      ].join('\n'),
    },
    servers: [{ url: '/', description: 'Este servidor' }],
    tags: [
      { name: 'Envío (v1)', description: 'Envío asíncrono con cola, idempotencia y adjuntos.' },
      { name: 'Plantillas', description: 'Gestión de plantillas de email, layouts y partials con versiones.' },
      { name: 'Branding', description: 'Identidad visual aplicada a todas las plantillas.' },
      { name: 'Jobs', description: 'Estado de envíos encolados.' },
      { name: 'Administración', description: 'Auditoría y métricas.' },
      { name: 'Heredados', description: 'Endpoints originales (contrato sin cambios).' },
      { name: 'Sistema', description: 'Salud del servicio.' },
    ],
    components: {
      securitySchemes: {
        ApiKey: { type: 'apiKey', in: 'header', name: 'x-api-key' },
        Bearer: { type: 'http', scheme: 'bearer' },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            ok: { type: 'boolean', const: false },
            error: { type: 'string', description: 'Mensaje legible' },
            code: { type: 'string', example: 'validation_error' },
            details: {},
            requestId: { type: 'string' },
          },
        },
        Recipients: {
          oneOf: [{ type: 'string', example: 'Juan Pérez <juan@correo.com>' }, { type: 'array', items: { type: 'string', format: 'email' }, maxItems: 100 }],
        },
        Attachment: {
          type: 'object', required: ['filename'],
          description: 'Usa `contentBase64` **o** `url` (https; IPs privadas bloqueadas). Tipos: pdf, xml, png, jpg, gif, webp, csv, txt, ics, zip, xlsx, docx.',
          properties: {
            filename: { type: 'string', example: 'factura-001.pdf' },
            contentBase64: { type: 'string' },
            url: { type: 'string', format: 'uri' },
          },
        },
        Email: {
          type: 'object', required: ['to'],
          properties: {
            to: ref('Recipients'), cc: ref('Recipients'), bcc: ref('Recipients'),
            replyTo: { type: 'string' },
            subject: { type: 'string', maxLength: 300, description: 'Opcional: si falta se usa el asunto por defecto de la plantilla.' },
            template: { type: 'string', default: 'generic', examples: templateNames },
            context: { type: 'object', additionalProperties: true, description: 'Variables de la plantilla.' },
            preheader: { type: 'string', maxLength: 200, description: 'Texto de vista previa en la bandeja de entrada.' },
            attachments: { type: 'array', items: ref('Attachment'), maxItems: 20 },
            headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Solo cabeceras X-*' },
            unsubscribeUrl: { type: 'string', format: 'uri', description: 'Agrega List-Unsubscribe y enlace en el pie.' },
            tags: { type: 'array', items: { type: 'string' }, maxItems: 10 },
          },
        },
        Job: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' }, jobId: { type: 'string', format: 'uuid' },
            status: { type: 'string', enum: ['queued', 'processing', 'sent', 'failed'] },
            attempts: { type: 'integer' }, result: { type: ['object', 'null'] }, error: { type: ['string', 'null'] },
            createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        TemplateWrite: {
          type: 'object', required: ['html'],
          properties: {
            html: { type: 'string', maxLength: 200000, description: 'Código Handlebars. Sin <script>, iframes, formularios ni atributos on*.' },
            subject: { type: 'string', description: 'Asunto por defecto (acepta variables Handlebars).' },
            description: { type: 'string' },
            layout: { type: 'string', description: 'Nombre del layout o "none". Por defecto "base". Solo para plantillas de email.' },
            sampleData: { type: 'object', additionalProperties: true, description: 'Datos de ejemplo para validar y previsualizar.' },
          },
        },
        TemplatePatch: { allOf: [ref('TemplateWrite')], required: [] },
        Template: {
          type: 'object',
          properties: {
            name: { type: 'string' }, kind: { type: 'string', enum: ['email', 'layout', 'partial'] },
            source: { type: 'string', enum: ['builtin', 'custom'] }, builtin: { type: 'boolean' },
            version: { type: 'integer', description: '0 = original incluida' },
            html: { type: 'string' }, subject: { type: 'string' }, description: { type: 'string' },
            layout: { type: 'string' }, sampleData: { type: 'object' }, variables: { type: 'array', items: { type: 'string' } },
            updatedAt: { type: ['string', 'null'] }, updatedBy: { type: ['string', 'null'] },
          },
        },
        TemplateList: { type: 'object', properties: { ok: { type: 'boolean' }, kind: { type: 'string' }, count: { type: 'integer' }, items: { type: 'array', items: ref('Template') } } },
        VersionMeta: { type: 'object', properties: { version: { type: 'integer' }, subject: { type: 'string' }, description: { type: 'string' }, createdAt: { type: 'string' }, createdBy: { type: 'string' }, note: { type: 'string' } } },
        Rendered: { type: 'object', properties: { ok: { type: 'boolean' }, subject: { type: 'string' }, html: { type: 'string' }, text: { type: 'string' } } },
        Branding: {
          type: 'object',
          properties: {
            name: { type: 'string' }, logoUrl: { type: 'string', description: 'https://' },
            primaryColor: { type: 'string', example: '#4F46E5' }, accentColor: { type: 'string', example: '#06B6D4' },
            website: { type: 'string' }, supportEmail: { type: 'string' }, address: { type: 'string' }, footerNote: { type: 'string' },
            lang: { type: 'string', example: 'es' },
            socialLinks: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, url: { type: 'string' } } } },
          },
        },
        LegacySendOk: { type: 'object', properties: { ok: { type: 'boolean' }, id: { type: 'string', description: 'Message-ID SMTP' } } },
        LegacyError: { type: 'object', properties: { error: { type: 'string', example: 'Invalid recipient' } } },
      },
    },
    security: [{ ApiKey: [] }, { Bearer: [] }],
    paths: {
      '/health': { get: { tags: ['Sistema'], summary: 'Liveness', security: [], responses: { 200: ok('OK', { type: 'object' }, { ok: true, service: 'mail-service' }) } } },
      '/ready': { get: { tags: ['Sistema'], summary: 'Readiness (verifica conexión SMTP)', security: [], responses: { 200: ok('Listo', { type: 'object' }), 503: err('SMTP no disponible') } } },

      '/v1/emails': {
        post: {
          tags: ['Envío (v1)'], summary: 'Encolar un correo con plantilla', parameters: [idempotency],
          description: 'Valida destinatarios, plantilla y adjuntos, y responde `202` con un `jobId`. El envío ocurre en segundo plano con reintentos.',
          requestBody: { required: true, ...json(ref('Email'), {
            to: 'cliente@correo.com',
            template: 'otp-code',
            context: { code: '482913', userName: 'Ana', purpose: 'verificar tu correo' },
            tags: ['onboarding'],
          }) },
          responses: { 202: ok('Encolado', ref('Job')), 200: ok('Duplicado (misma Idempotency-Key)', ref('Job')), 404: err('Plantilla no existe'), ...common },
        },
      },
      '/v1/emails/batch': {
        post: {
          tags: ['Envío (v1)'], summary: 'Encolar hasta 100 correos (todo o nada)',
          requestBody: { required: true, ...json({ type: 'object', required: ['messages'], properties: { messages: { type: 'array', items: ref('Email'), maxItems: 100 } } }) },
          responses: { 202: ok('Encolados', { type: 'object', properties: { ok: { type: 'boolean' }, count: { type: 'integer' }, jobs: { type: 'array', items: ref('Job') } } }), ...common },
        },
      },
      '/v1/emails/render': {
        post: {
          tags: ['Envío (v1)'], summary: 'Renderizar sin enviar (asunto, HTML y texto)',
          requestBody: { required: true, ...json(ref('Email'), { template: 'welcome', context: { userName: 'Ana' } }) },
          responses: { 200: ok('Render', ref('Rendered')), ...common },
        },
      },

      '/v1/jobs': {
        get: {
          tags: ['Jobs'], summary: 'Listar jobs propios (admin: todos)',
          parameters: [
            { name: 'status', in: 'query', schema: { type: 'string', enum: ['queued', 'processing', 'sent', 'failed'] } },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, maximum: 200 } },
          ],
          responses: { 200: ok('Jobs', { type: 'object', properties: { jobs: { type: 'array', items: ref('Job') } } }), ...common },
        },
      },
      '/v1/jobs/{id}': {
        get: {
          tags: ['Jobs'], summary: 'Estado de un job', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: ok('Job', ref('Job')), 404: err('No encontrado o expirado'), ...common },
        },
      },

      '/v1/templates/validate': {
        post: {
          tags: ['Plantillas'], summary: 'Validar y previsualizar código sin guardarlo',
          requestBody: { required: true, ...json({ allOf: [ref('TemplateWrite')], properties: { kind: { type: 'string', enum: ['email', 'layout', 'partial'] }, context: { type: 'object' } } }) },
          responses: { 200: ok('Válida', { type: 'object', properties: { valid: { type: 'boolean' }, preview: ref('Rendered') } }), 422: err('Inválida'), ...common },
        },
      },
      '/v1/templates/{name}/preview': {
        post: {
          tags: ['Plantillas'], summary: 'Previsualizar una plantilla guardada (sampleData + context)', parameters: [nameParam],
          requestBody: { required: false, ...json({ type: 'object', properties: { context: { type: 'object' }, subject: { type: 'string' }, preheader: { type: 'string' }, format: { type: 'string', enum: ['json', 'html'], default: 'json' } } }) },
          responses: { 200: ok('Render', ref('Rendered')), 404: err('No existe'), ...common },
        },
      },
      ...collectionPaths('templates', 'email', 'plantillas de email'),
      ...collectionPaths('layouts', 'layout', 'layouts'),
      ...collectionPaths('partials', 'partial', 'partials'),

      '/v1/branding': {
        get: { tags: ['Branding'], summary: 'Obtener branding', responses: { 200: ok('Branding', { type: 'object', properties: { branding: ref('Branding') } }), ...common } },
        put: {
          tags: ['Branding'], summary: 'Actualizar branding (parcial, requiere admin)',
          requestBody: { required: true, ...json(ref('Branding'), { name: 'Mi Empresa', primaryColor: '#0E7490', accentColor: '#22D3EE', supportEmail: 'soporte@miempresa.com' }) },
          responses: { 200: ok('Actualizado', { type: 'object', properties: { branding: ref('Branding') } }), ...common },
        },
      },
      '/v1/icons': {
        get: { tags: ['Plantillas'], summary: 'Íconos Material Symbols disponibles para {{icon}} y los partials', responses: { 200: ok('Íconos', { type: 'object', properties: { icons: { type: 'array', items: { type: 'string' } } } }), ...common } },
      },
      '/v1/audit': {
        get: { tags: ['Administración'], summary: 'Registro de auditoría de cambios (admin)', parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', default: 100 } }], responses: { 200: ok('Entradas', { type: 'object' }), ...common } },
      },
      '/v1/stats': {
        get: { tags: ['Administración'], summary: 'Métricas de la cola', responses: { 200: ok('Métricas', { type: 'object' }), ...common } },
      },

      // ───── Heredados ─────
      '/send': {
        post: {
          tags: ['Heredados'], summary: 'Enviar con plantilla (síncrono)',
          requestBody: { required: true, ...json({ type: 'object', required: ['to', 'subject'], properties: { to: { type: 'string' }, subject: { type: 'string' }, template: { type: 'string', default: 'generic' }, context: { type: 'object' } } }, { to: 'destino@correo.com', subject: 'Hola', template: 'generic', context: { title: 'Bienvenido', message: 'Gracias por registrarte' } }) },
          responses: { 200: ok('Enviado', ref('LegacySendOk')), 400: ok('Inválido', ref('LegacyError')), 401: ok('No autorizado', ref('LegacyError')), 500: ok('Falló el envío', ref('LegacyError')) },
        },
      },
      '/notify/login-success': {
        post: {
          tags: ['Heredados'], summary: 'Alerta de inicio de sesión',
          requestBody: { required: true, ...json({ type: 'object', required: ['to'], properties: { to: { type: 'string' }, userName: { type: 'string' }, device: { type: 'string' }, browser: { type: 'string' }, location: { type: 'string' }, ip: { type: 'string' }, secureUrl: { type: 'string' } } }, { to: 'destino@correo.com', userName: 'Anthony' }) },
          responses: { 200: ok('Enviado', ref('LegacySendOk')), 400: ok('Inválido', ref('LegacyError')), 500: ok('Falló', ref('LegacyError')) },
        },
      },
      '/notify/new-order': {
        post: {
          tags: ['Heredados'], summary: 'Confirmación de orden',
          requestBody: { required: true, ...json({ type: 'object', required: ['to'], properties: { to: { type: 'string' }, orderId: { type: 'string' }, orderTotal: { type: 'number' }, items: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, qty: { type: 'number' }, price: { type: 'number' } } } } } }, { to: 'destino@correo.com', orderId: 'A-001', orderTotal: 123.45, items: [{ name: 'Producto', qty: 2, price: 10 }] }) },
          responses: { 200: ok('Enviado', ref('LegacySendOk')), 400: ok('Inválido', ref('LegacyError')), 500: ok('Falló', ref('LegacyError')) },
        },
      },
      '/notify/generic': {
        post: {
          tags: ['Heredados'], summary: 'Correo de propósito general',
          requestBody: { required: true, ...json({ type: 'object', required: ['to', 'subject'], properties: { to: { type: 'string' }, subject: { type: 'string' }, title: { type: 'string' }, message: { type: 'string', description: 'HTML (se sanitiza)' }, details: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'string' } } } }, ctaUrl: { type: 'string' }, ctaText: { type: 'string' } } }) },
          responses: { 200: ok('Enviado', ref('LegacySendOk')), 400: ok('Inválido', ref('LegacyError')), 500: ok('Falló', ref('LegacyError')) },
        },
      },
      '/notify/custom': {
        post: {
          tags: ['Heredados'], summary: 'Notificación personalizada',
          requestBody: { required: true, ...json({ type: 'object', required: ['to'], properties: { to: { type: 'string' }, title: { type: 'string' }, message: { type: 'string' }, ctaUrl: { type: 'string' }, ctaText: { type: 'string' } } }) },
          responses: { 200: ok('Enviado', ref('LegacySendOk')), 400: ok('Inválido', ref('LegacyError')), 500: ok('Falló', ref('LegacyError')) },
        },
      },
      '/send-html': {
        post: {
          tags: ['Heredados'], summary: 'Enviar HTML arbitrario (requiere mail:send:raw)',
          requestBody: { required: true, ...json({ type: 'object', required: ['to', 'subject', 'html'], properties: { to: { type: 'string' }, subject: { type: 'string' }, html: { type: 'string' }, text: { type: 'string' } } }) },
          responses: { 200: ok('Enviado', ref('LegacySendOk')), 400: ok('Inválido', ref('LegacyError')), 403: err('Sin permiso'), 500: ok('Falló', ref('LegacyError')) },
        },
      },
      '/documents/send': {
        post: {
          tags: ['Heredados'], summary: 'Encolar comprobante electrónico (RIDE PDF + XML)', parameters: [idempotency],
          requestBody: { required: true, ...json({
            type: 'object', required: ['to', 'tipoDocumento', 'adjuntos'],
            properties: {
              to: { type: 'string' }, cc: ref('Recipients'), bcc: ref('Recipients'), destinatarioNombre: { type: 'string' },
              tipoDocumento: { type: 'string', enum: ['factura', 'nota_credito', 'nota_debito', 'retencion', 'guia_remision', 'liquidacion', 'cotizacion', 'general'] },
              subject: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' },
              documento: { type: 'object', properties: { numero: { type: 'string' }, claveAcceso: { type: 'string' }, fechaEmision: { type: 'string' }, razonSocialEmisor: { type: 'string' }, total: { type: 'string' }, moneda: { type: 'string', example: 'USD' } } },
              adjuntos: { type: 'object', properties: { pdfBase64: { type: 'string' }, pdfUrl: { type: 'string' }, xmlBase64: { type: 'string' }, xmlUrl: { type: 'string' } } },
            },
          }) },
          responses: { 202: ok('Encolado', { type: 'object', properties: { ok: { type: 'boolean' }, jobId: { type: 'string' }, status: { type: 'string' } } }), 400: ok('Inválido', ref('LegacyError')), 500: ok('Falló', ref('LegacyError')) },
        },
      },
      '/jobs/{id}': {
        get: { tags: ['Heredados'], summary: 'Estado de un job', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: ok('Job', ref('Job')), 404: ok('No encontrado', ref('LegacyError')) } },
      },
      '/queue/stats': {
        get: { tags: ['Heredados'], summary: 'Métricas básicas de la cola', responses: { 200: ok('Stats', { type: 'object', properties: { ok: { type: 'boolean' }, pending: { type: 'integer' }, active: { type: 'integer' }, total: { type: 'integer' } } }) } },
      },
      ...(config.features.preview ? {
        '/preview/{template}': {
          get: { tags: ['Heredados'], summary: 'Vista previa HTML con datos de ejemplo', security: [], parameters: [{ name: 'template', in: 'path', required: true, schema: { type: 'string', examples: templateNames } }], responses: { 200: { description: 'HTML', content: { 'text/html': {} } } } },
        },
      } : {}),
    },
  };
}
