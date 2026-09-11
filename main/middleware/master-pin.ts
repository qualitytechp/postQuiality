import { Request, Response, NextFunction } from 'express';
import { authorizeMasterPin, isMasterPinAvailable } from '../services/master-pin';

/**
 * Exige el PIN Maestro sólo cuando el dispositivo es capaz de tenerlo.
 *
 * Sin llavero del sistema no hay PIN ni forma de fijar uno, así que exigirlo
 * no protege una decisión: cierra la puerta para siempre. Para una operación
 * que no destruye nada —crear una copia— queda el rol de dueño, que es la
 * misma protección que ya tiene la exportación a JSON de esa misma pantalla.
 *
 * Restaurar, borrar copias e inicializar la base siguen usando requireMasterPin
 * sin excepción: esas sí destruyen, y ahí el PIN es la última defensa.
 */
export function requireMasterPinWhenAvailable(req: Request, res: Response, next: NextFunction): void {
  if (!isMasterPinAvailable()) {
    next();
    return;
  }
  requireMasterPin(req, res, next);
}

/** Requires master_pin in request body; rate limit is scoped per-route. */
export function requireMasterPin(req: Request, res: Response, next: NextFunction): void {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const routeKey = req.baseUrl + req.path;
  const result = authorizeMasterPin(req.body?.master_pin, `http:${ip}:${routeKey}`);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  next();
}
