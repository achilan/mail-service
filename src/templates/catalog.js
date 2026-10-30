// Catálogo de plantillas incluidas: descripción, asunto por defecto, variables
// que aceptan y datos de ejemplo (usados en /preview y en la API de plantillas).

const pafide = {
  title: 'Tu pase para la Clínica Deportiva PAFIDE 2026',
  message: '<p>Hola <strong>Anthony Chilan</strong>, tu inscripción a la <strong>Clínica Deportiva PAFIDE 2026 — Taller Práctico</strong> quedó registrada.</p><p>Adjuntamos tu pase en PDF con el código QR. Preséntalo en la entrada del evento, impreso o desde la pantalla del teléfono. Es personal e intransferible.</p><p>Tu pago ya fue verificado por la organización.</p>',
  details: [
    { label: 'Código de acceso', value: 'PAFIDE-SDGDY-ZUNRR' },
    { label: 'Documento', value: '1316262193' },
    { label: 'Fecha', value: 'Sábado a partir de las 08:00 AM' },
    { label: 'Lugar', value: 'UNESUM — Jipijapa, Manabí, Ecuador' },
  ],
};

export const CATALOG = {
  email: {
    generic: {
      description: 'Plantilla de propósito general: título, mensaje (HTML seguro), lista de datos y botón.',
      subject: '{{title}}',
      variables: ['title', 'subtitle', 'eyebrow', 'icon', 'tone', 'message', 'details[]{label,value,mono}', 'detailsTitle', 'ctaUrl', 'ctaText', 'note'],
      sampleData: { ...pafide, icon: 'confirmation_number', eyebrow: 'Inscripción confirmada', ctaUrl: 'https://example.com/mi-pase', ctaText: 'Descargar mi pase' },
    },
    notification: {
      description: 'Aviso corto con tono semántico (info, success, warning, danger) y botón opcional.',
      subject: '{{title}}',
      variables: ['title', 'subtitle', 'message', 'tone', 'icon', 'eyebrow', 'details[]', 'ctaUrl', 'ctaText'],
      sampleData: {
        title: 'Tu reporte mensual está listo',
        message: 'Procesamos la información de octubre. Ya puedes revisar las métricas y descargar el PDF.',
        tone: 'success',
        icon: 'analytics',
        ctaUrl: 'https://example.com/reportes/2026-10',
        ctaText: 'Ver reporte',
      },
    },
    'login-success': {
      description: 'Alerta de seguridad por nuevo inicio de sesión, con datos del dispositivo.',
      subject: 'Nuevo inicio de sesión en tu cuenta',
      variables: ['userName', 'loginAt', 'device', 'browser', 'location', 'ip', 'secureUrl'],
      sampleData: {
        userName: 'Anthony',
        device: 'MacBook Pro · macOS',
        browser: 'Safari 19',
        location: 'Guayaquil, Ecuador',
        ip: '181.198.24.10',
        secureUrl: 'https://example.com/seguridad',
      },
    },
    'new-order': {
      description: 'Confirmación de pedido con líneas, totales, dirección y seguimiento.',
      subject: 'Confirmación de tu pedido #{{orderId}}',
      variables: ['orderId', 'orderTotal', 'items[]{name,qty,price}', 'currency', 'customerName', 'subtotal', 'shipping', 'tax', 'discount', 'shippingAddress', 'orderUrl', 'nextSteps'],
      sampleData: {
        orderId: 'A-001',
        customerName: 'Anthony',
        currency: 'USD',
        items: [
          { name: 'Producto Premium', qty: 2, price: 50.0 },
          { name: 'Servicio Extra', qty: 1, price: 23.45 },
        ],
        subtotal: 123.45,
        shipping: 0,
        orderTotal: 123.45,
        shippingAddress: 'Av. 9 de Octubre 100, Guayaquil, Ecuador',
        orderUrl: 'https://example.com/pedidos/A-001',
      },
    },
    document: {
      description: 'Envío de comprobante electrónico (RIDE PDF + XML) — factura, nota de crédito, retención, etc.',
      subject: '{{tipoLabel}} {{numero}}',
      variables: ['tipoLabel', 'destinatarioNombre', 'razonSocialEmisor', 'numero', 'fechaEmision', 'total', 'currency', 'claveAcceso', 'conXml'],
      sampleData: {
        tipoLabel: 'Factura',
        destinatarioNombre: 'Juan Pérez',
        razonSocialEmisor: 'Mi Empresa S.A.',
        numero: '001-001-000000123',
        fechaEmision: '06/06/2026',
        total: '123.45',
        claveAcceso: '0606202601179214673900110010010000001231234567813',
        conXml: true,
      },
    },
    welcome: {
      description: 'Bienvenida para cuentas nuevas con pasos numerados y botón principal.',
      subject: 'Te damos la bienvenida a {{brand.name}}',
      variables: ['userName', 'subtitle', 'message', 'steps[]{title,text}', 'ctaUrl', 'ctaText'],
      sampleData: {
        userName: 'Anthony',
        steps: [
          { title: 'Completa tu perfil', text: 'Agrega tu foto y datos de contacto para personalizar tu experiencia.' },
          { title: 'Configura tus preferencias', text: 'Elige qué notificaciones quieres recibir y cómo.' },
          { title: 'Invita a tu equipo', text: 'Colaborar es más fácil cuando todos están en el mismo lugar.' },
        ],
        ctaUrl: 'https://example.com/onboarding',
      },
    },
    'password-reset': {
      description: 'Restablecimiento de contraseña con enlace, vencimiento y enlace alternativo.',
      subject: 'Restablece tu contraseña de {{brand.name}}',
      variables: ['userName', 'resetUrl', 'expiresIn', 'ip'],
      sampleData: {
        userName: 'Anthony',
        resetUrl: 'https://example.com/reset?token=7f3c9a1e5b',
        expiresIn: '30 minutos',
        ip: '181.198.24.10',
      },
    },
    'otp-code': {
      description: 'Código de verificación de un solo uso (OTP / 2FA / verificación de email).',
      subject: '{{code}} es tu código de verificación',
      variables: ['code', 'userName', 'purpose', 'expiresIn', 'title'],
      sampleData: { code: '482913', userName: 'Anthony', purpose: 'verificar tu correo electrónico', expiresIn: '10 minutos' },
    },
    'event-ticket': {
      description: 'Pase / entrada a evento con diseño de ticket, código de acceso y QR.',
      subject: 'Tu entrada para {{eventName}}',
      variables: ['eventName', 'attendeeName', 'eventDate', 'venue', 'accessCode', 'qrUrl', 'ticketType', 'message', 'details[]', 'ctaUrl', 'ctaText', 'note'],
      sampleData: {
        eventName: 'Clínica Deportiva PAFIDE 2026',
        ticketType: 'Taller práctico',
        attendeeName: 'Anthony Chilan',
        eventDate: 'Sábado · 08:00 AM',
        venue: 'UNESUM — Jipijapa, Manabí',
        accessCode: 'PAFIDE-SDGDY-ZUNRR',
        qrUrl: 'https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=PAFIDE-SDGDY-ZUNRR',
        details: [{ label: 'Documento', value: '1316262193' }, { label: 'Pago', value: 'Verificado' }],
      },
    },
  },
  layout: {
    base: { description: 'Layout principal: marca, tarjeta, pie, modo oscuro y soporte Outlook.' },
  },
  partial: {
    hero: { description: 'Encabezado con ícono Material, etiqueta, título y bajada. Params: icon (nombre Material, ej. "shield_lock"), tone, eyebrow, title, subtitle.' },
    button: { description: 'Botón compatible con Outlook. Params: url, text, color, align.' },
    panel: { description: 'Contenedor de datos (bloque). Param: heading.' },
    row: { description: 'Fila etiqueta/valor para usar dentro de panel. Params: label, value, mono, first, color.' },
    details: { description: 'Lista de datos [{label, value, mono}]. Params: items, heading.' },
    callout: { description: 'Aviso destacado. Params: tone, icon (nombre Material), title, text (o bloque).' },
    code: { description: 'Código grande tipo OTP. Params: value, label.' },
    divider: { description: 'Separador horizontal.' },
    signature: { description: 'Firma con el nombre de la marca. Param: signoff.' },
    fineprint: { description: 'Texto pequeño secundario (bloque o text).' },
  },
};
