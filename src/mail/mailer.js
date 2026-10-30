// Transporte de correo. SMTP con pool (reutiliza conexiones TLS) o `json`
// para pruebas/dry-run: no envía nada y devuelve el mensaje generado.

import { createTransport } from 'nodemailer';
import { htmlToText } from './text.js';

export function createMailer({ mail }, logger) {
  const { smtp } = mail;
  const transport = mail.transport === 'json'
    ? createTransport({ jsonTransport: true })
    : createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: { user: smtp.user, pass: smtp.pass },
      pool: true,
      maxConnections: smtp.maxConnections,
      maxMessages: smtp.maxMessages,
      connectionTimeout: smtp.connectionTimeout,
      greetingTimeout: smtp.greetingTimeout,
      socketTimeout: smtp.socketTimeout,
      // Nunca degradar a texto plano ni aceptar certificados inválidos.
      requireTLS: !smtp.secure,
      tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
      ...(mail.dkim ? { dkim: mail.dkim } : {}),
    });

  const from = { name: mail.fromName, address: mail.fromEmail };
  const sent = []; // solo se llena en modo json, útil para tests

  async function send({ to, cc, bcc, replyTo, subject, html, text, attachments, headers, unsubscribeUrl }) {
    const message = {
      from,
      to, cc, bcc,
      replyTo: replyTo || mail.replyTo,
      subject,
      html,
      text: text || htmlToText(html),
      attachments,
      headers: { ...(headers || {}) },
      disableFileAccess: true, // los adjuntos no pueden leer archivos del servidor
      disableUrlAccess: true,  // ni descargar URLs (eso lo hace safeFetch)
    };
    if (unsubscribeUrl) {
      message.list = { unsubscribe: { url: unsubscribeUrl, comment: 'Darse de baja' } };
    }
    const info = await transport.sendMail(message);
    if (mail.transport === 'json') {
      sent.push(JSON.parse(info.message));
      if (sent.length > 200) sent.shift();
    }
    logger?.info('mail.sent', { messageId: info.messageId, recipients: [to, cc, bcc].flat().filter(Boolean).length });
    return { messageId: info.messageId };
  }

  async function verify() {
    if (mail.transport === 'json') return true;
    return transport.verify();
  }

  return { send, verify, close: () => transport.close(), sent };
}
