import { Role } from "@prisma/client";
import type { Express, NextFunction, Request, Response } from "express";
import express from "express";
import { z } from "zod";
import {
  createHttpLogger,
  createLogger,
  createRedisClient,
  correlationIdMiddleware,
  extractBearerToken,
  healthHandler,
  isTokenBlacklisted,
  prisma,
  readyHandler,
  takeSlidingWindowToken,
  verifyAccessToken
} from "@ordersystem/shared";
import { authEnv, type AuthEnv } from "./env";
import { createAuthService } from "./auth-service";

type AuthenticatedRequest = Request & {
  authUser?: {
    userId: string;
    email: string;
    role: Role;
    jti: string;
  };
};

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8)
});

const loginSchema = signupSchema;

const refreshSchema = z.object({
  refreshToken: z.string().min(20)
});

const logoutSchema = z.object({
  refreshToken: z.string().min(20).optional()
});

export function createApp(env: AuthEnv = authEnv): Express {
  const logger = createLogger("auth-service", env.LOG_LEVEL);
  const redis = createRedisClient(env.REDIS_URL);
  const authService = createAuthService({ prisma, redis, env });
  const app = express();

  app.use(express.json());
  app.use(correlationIdMiddleware);
  app.use(createHttpLogger(logger));

  const requireAccessToken = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
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
  app.get("/ready", async (_req, res) => {
    await readyHandler(_req, res);
  });

  app.post("/auth/signup", async (req, res) => {
    const payload = signupSchema.parse(req.body);
    const session = await authService.signup(payload);

    if (!session) {
      return res.status(409).json({ message: "User already exists" });
    }

    res.status(201).json(session);
  });

  app.post("/auth/login", async (req, res) => {
    const payload = loginSchema.parse(req.body);
    const limiterKey = `ratelimit:login:${req.ip}:${payload.email.toLowerCase()}`;
    const rateLimit = await takeSlidingWindowToken(
      redis,
      limiterKey,
      env.LOGIN_RATE_LIMIT_WINDOW_SECONDS,
      env.LOGIN_RATE_LIMIT_MAX
    );

    res.setHeader("x-ratelimit-limit", env.LOGIN_RATE_LIMIT_MAX.toString());
    res.setHeader("x-ratelimit-remaining", Math.max(0, env.LOGIN_RATE_LIMIT_MAX - rateLimit.count).toString());

    if (!rateLimit.allowed) {
      return res.status(429).json({
        message: "Too many login attempts",
        retryAfterSeconds: rateLimit.retryAfterSeconds
      });
    }

    const session = await authService.login(payload);
    if (!session) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    res.status(200).json(session);
  });

  app.post("/auth/refresh", async (req, res) => {
    const payload = refreshSchema.parse(req.body);
    const session = await authService.refresh(payload.refreshToken);

    if (!session) {
      return res.status(401).json({ message: "Invalid refresh token" });
    }

    res.status(200).json(session);
  });

  app.post("/auth/logout", requireAccessToken, async (req: AuthenticatedRequest, res) => {
    const payload = logoutSchema.parse(req.body ?? {});
    const accessToken = extractBearerToken(req) ?? undefined;
    await authService.logout({
      refreshToken: payload.refreshToken,
      accessToken
    });
    res.status(204).send();
  });

  app.get("/auth/me", requireAccessToken, async (req: AuthenticatedRequest, res) => {
    const user = await prisma.user.findUnique({
      where: { id: req.authUser!.userId },
      select: {
        id: true,
        email: true,
        role: true,
        createdAt: true
      }
    });

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.status(200).json(user);
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ error }, "Unhandled auth-service error");
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
