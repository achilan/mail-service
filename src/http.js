// Utilidades HTTP compartidas: error tipado, wrapper async y validación con zod.

export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// Express 4 no captura rechazos de promesas: los pasamos a next().
export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Valida `data` con un schema zod; lanza 400 con el detalle por campo.
export function parse(schema, data) {
  const result = schema.safeParse(data ?? {});
  if (result.success) return result.data;
  const details = result.error.issues.slice(0, 20).map((i) => ({
    path: i.path.join('.') || '(body)',
    message: i.message,
  }));
  throw new HttpError(400, 'validation_error', 'Datos inválidos', details);
}
