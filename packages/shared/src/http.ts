import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { prisma } from "./prisma";

export function correlationIdMiddleware(req: Request, res: Response, next: NextFunction) {
  const incoming = req.headers["x-correlation-id"];
  const correlationId = typeof incoming === "string" ? incoming : crypto.randomUUID();
  req.headers["x-correlation-id"] = correlationId;
  res.setHeader("x-correlation-id", correlationId);
  next();
}

export function asyncHandler<TRequest extends Request>(
  handler: (req: TRequest, res: Response, next: NextFunction) => Promise<unknown>
) {
  return (req: TRequest, res: Response, next: NextFunction) => {
    void handler(req, res, next).catch(next);
  };
}

export function healthHandler(_req: Request, res: Response) {
  res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
}

export async function readyHandler(_req: Request, res: Response) {
  await prisma.$queryRaw`SELECT 1`;
  res.status(200).json({ status: "ready", timestamp: new Date().toISOString() });
}
