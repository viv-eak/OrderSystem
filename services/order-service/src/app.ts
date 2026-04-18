import crypto from "node:crypto";
import type { Express, NextFunction, Request, Response } from "express";
import express from "express";
import { z } from "zod";
import {
  correlationIdMiddleware,
  createHttpLogger,
  createLogger,
  createRedisClient,
  healthHandler,
  prisma,
  readyHandler,
  userFromGatewayHeaders
} from "@ordersystem/shared";
import { createOrderService } from "./order-service";
import { orderEnv, type OrderEnv } from "./env";

const orderItemSchema = z.object({
  sku: z.string().min(1),
  name: z.string().min(1),
  quantity: z.number().int().positive(),
  unitPrice: z.number().positive()
});

const createOrderSchema = z.object({
  items: z.array(orderItemSchema).min(1)
});

function requireGatewayIdentity(req: Request, res: Response, next: NextFunction) {
  const user = userFromGatewayHeaders(req);
  if (!user) {
    return res.status(401).json({ message: "Missing gateway identity headers" });
  }

  (req as Request & { viewer: ReturnType<typeof userFromGatewayHeaders> }).viewer = user;
  next();
}

function getViewer(req: Request) {
  return (req as unknown as {
    viewer: NonNullable<ReturnType<typeof userFromGatewayHeaders>>;
  }).viewer;
}

export function createApp(env: OrderEnv = orderEnv): Express {
  const logger = createLogger("order-service", env.LOG_LEVEL);
  const redis = createRedisClient(env.REDIS_URL);
  const service = createOrderService({ prisma, redis });
  const app = express();

  app.use(express.json());
  app.use(correlationIdMiddleware);
  app.use(createHttpLogger(logger));

  app.get("/health", healthHandler);
  app.get("/ready", async (_req, res) => {
    await readyHandler(_req, res);
  });

  app.use("/orders", requireGatewayIdentity);

  app.post("/orders", async (req, res) => {
    const viewer = getViewer(req);
    const payload = createOrderSchema.parse(req.body);
    const order = await service.createOrder(
      {
        userId: viewer.userId,
        email: viewer.email,
        role: viewer.role,
        jti: viewer.jti
      },
      payload,
      (req.headers["x-correlation-id"] as string | undefined) ?? crypto.randomUUID()
    );

    res.status(201).json(order);
  });

  app.get("/orders/me", async (req, res) => {
    const viewer = getViewer(req);
    const orders = await service.listOrders({
      userId: viewer.userId,
      email: viewer.email,
      role: viewer.role,
      jti: viewer.jti
    });

    res.status(200).json(orders);
  });

  app.get("/orders/:orderId", async (req, res) => {
    const viewer = getViewer(req);
    const order = await service.getOrderById(
      {
        userId: viewer.userId,
        email: viewer.email,
        role: viewer.role,
        jti: viewer.jti
      },
      req.params.orderId
    );

    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    res.status(200).json(order);
  });

  app.post("/orders/:orderId/cancel", async (req, res) => {
    const viewer = getViewer(req);
    const result = await service.cancelOrder(
      {
        userId: viewer.userId,
        email: viewer.email,
        role: viewer.role,
        jti: viewer.jti
      },
      req.params.orderId,
      (req.headers["x-correlation-id"] as string | undefined) ?? crypto.randomUUID()
    );

    if (!result) {
      return res.status(404).json({ message: "Order not found" });
    }

    if (!result.cancelled) {
      return res.status(409).json({
        message: `Order cannot be cancelled from status ${result.status}`
      });
    }

    res.status(200).json(result);
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ error }, "Unhandled order-service error");
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        message: "Validation failed",
        issues: error.flatten()
      });
    }

    res.status(500).json({ message: "Internal server error" });
  });

  return app;
}
