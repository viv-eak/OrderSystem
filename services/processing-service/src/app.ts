import type { Express, Request, Response } from "express";
import express from "express";
import {
  correlationIdMiddleware,
  createHttpLogger,
  createLogger,
  healthHandler,
  readyHandler
} from "@ordersystem/shared";
import { processingEnv, type ProcessingEnv } from "./env";

export function createApp(env: ProcessingEnv = processingEnv): Express {
  const logger = createLogger("processing-service", env.LOG_LEVEL);
  const app = express();

  app.use(correlationIdMiddleware);
  app.use(createHttpLogger(logger));

  app.get("/health", healthHandler);
  app.get("/ready", async (req: Request, res: Response) => {
    await readyHandler(req, res);
  });

  return app;
}
