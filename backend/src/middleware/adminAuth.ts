import type { Request, Response, NextFunction } from "express";

/**
 * Protege los endpoints /v1/admin/*: exige el header `x-admin-key` igual a ADMIN_API_KEY.
 * Comparación simple (el secreto vive en el entorno del server).
 */
export function adminAuth(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.ADMIN_API_KEY;
  if (!expected) {
    res.status(500).json({ error: "ADMIN_API_KEY no configurada en el server" });
    return;
  }
  const got = req.header("x-admin-key");
  if (got !== expected) {
    res.status(401).json({ error: "no autorizado" });
    return;
  }
  next();
}
