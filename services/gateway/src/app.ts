import http from "node:http";
import type { Express, NextFunction, Request, Response } from "express";
import express from "express";
import {
  correlationIdMiddleware,
  createHttpLogger,
  createLogger,
  createRedisClient,
  extractBearerToken,
  healthHandler,
  isTokenBlacklisted,
  readyHandler,
  takeSlidingWindowToken,
  verifyAccessToken
} from "@ordersystem/shared";
import { gatewayEnv, type GatewayEnv } from "./env";
import { proxyJsonRequest } from "./proxy";
import { createSocketHub } from "./socket-hub";

type GatewayRequest = Request & {
  authUser?: {
    userId: string;
    email: string;
    role: string;
    jti: string;
  };
};

type GatewayBootstrap = {
  app: Express;
  server: http.Server;
  socketHub: {
    close(): Promise<void>;
  };
};

export function createGateway(env: GatewayEnv = gatewayEnv): GatewayBootstrap {
  const logger = createLogger("gateway", env.LOG_LEVEL);
  const redis = createRedisClient(env.REDIS_URL);
  const app = express();
  const allowedOrigins = new Set(
    env.CORS_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
  );

  const corsMiddleware = (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }

    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Correlation-Id");

    if (req.method === "OPTIONS") {
      return res.status(204).send();
    }

    next();
  };

  app.use(corsMiddleware);
  app.use(express.json());
  app.use(correlationIdMiddleware);
  app.use(createHttpLogger(logger));

  const apiRateLimit = async (req: Request, res: Response, next: NextFunction) => {
    const token = extractBearerToken(req);
    let identity = req.ip ?? "anonymous";

    if (token) {
      try {
        const payload = verifyAccessToken(token, env.ACCESS_TOKEN_SECRET);
        identity = payload.sub;
      } catch {
        identity = req.ip ?? "anonymous";
      }
    }

    const rateLimit = await takeSlidingWindowToken(
      redis,
      `ratelimit:api:${identity}`,
      env.API_RATE_LIMIT_WINDOW_SECONDS,
      env.API_RATE_LIMIT_MAX
    );

    if (!rateLimit.allowed) {
      return res.status(429).json({
        message: "API rate limit exceeded",
        retryAfterSeconds: rateLimit.retryAfterSeconds
      });
    }

    next();
  };

  const requireAccessToken = async (req: GatewayRequest, res: Response, next: NextFunction) => {
    try {
      const token = extractBearerToken(req);
      if (!token) {
        return res.status(401).json({ message: "Missing bearer token" });
      }

      const payload = verifyAccessToken(token, env.ACCESS_TOKEN_SECRET);
      const blacklisted = await isTokenBlacklisted(redis, payload.jti);
      if (blacklisted) {
        return res.status(401).json({ message: "Token has been revoked" });
      }

      req.authUser = {
        userId: payload.sub,
        email: payload.email,
        role: payload.role,
        jti: payload.jti
      };
      next();
    } catch (_error) {
      res.status(401).json({ message: "Invalid access token" });
    }
  };

  app.get("/health", healthHandler);
  app.get("/ready", async (req, res) => {
    await readyHandler(req, res);
  });

  app.use("/auth", apiRateLimit);
  app.use("/orders", apiRateLimit, requireAccessToken);

  app.use("/auth", async (req, res, next) => {
    try {
      await proxyJsonRequest(req, res, env.AUTH_SERVICE_URL);
    } catch (error) {
      next(error);
    }
  });

  app.use("/orders", async (req: GatewayRequest, res, next) => {
    try {
      await proxyJsonRequest(req, res, env.ORDER_SERVICE_URL, {
        "x-user-id": req.authUser!.userId,
        "x-user-email": req.authUser!.email,
        "x-user-role": req.authUser!.role,
        "x-user-jti": req.authUser!.jti
      });
    } catch (error) {
      next(error);
    }
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ error }, "Unhandled gateway error");
    res.status(502).json({ message: "Gateway proxy error" });
  });

  const server = http.createServer(app);
  const socketHub = createSocketHub(server, redis, env, logger);

  return { app, server, socketHub };
}
