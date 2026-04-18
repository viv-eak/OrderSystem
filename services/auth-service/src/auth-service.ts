import { Role } from "@prisma/client";
import type Redis from "ioredis";
import type { PrismaClient } from "@prisma/client";
import {
  createAccessToken,
  generateOpaqueToken,
  getTokenExpiryEpochSeconds,
  hashPassword,
  hashToken,
  verifyPassword
} from "@ordersystem/shared";
import type { AuthEnv } from "./env";

export function createAuthService(deps: {
  prisma: PrismaClient;
  redis: Redis;
  env: AuthEnv;
}) {
  const { prisma, env } = deps;

  async function issueSession(user: { id: string; email: string; role: Role }, rotatedFrom?: string) {
    const access = createAccessToken(
      {
        sub: user.id,
        email: user.email,
        role: user.role
      },
      {
        secret: env.ACCESS_TOKEN_SECRET,
        expiresInMinutes: env.ACCESS_TOKEN_TTL_MINUTES
      }
    );

    const refreshToken = generateOpaqueToken();
    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(refreshToken),
        expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000),
        rotatedFrom
      }
    });

    return {
      accessToken: access.token,
      refreshToken
    };
  }

  return {
    async signup(input: { email: string; password: string }) {
      const existing = await prisma.user.findUnique({
        where: { email: input.email.toLowerCase() }
      });

      if (existing) {
        return null;
      }

      const user = await prisma.user.create({
        data: {
          email: input.email.toLowerCase(),
          passwordHash: await hashPassword(input.password),
          role: Role.USER
        }
      });

      const session = await issueSession(user);
      return {
        user: {
          id: user.id,
          email: user.email,
          role: user.role
        },
        ...session
      };
    },

    async login(input: { email: string; password: string }) {
      const user = await prisma.user.findUnique({
        where: { email: input.email.toLowerCase() }
      });

      if (!user) {
        return null;
      }

      const passwordValid = await verifyPassword(input.password, user.passwordHash);
      if (!passwordValid) {
        return null;
      }

      const session = await issueSession(user);
      return {
        user: {
          id: user.id,
          email: user.email,
          role: user.role
        },
        ...session
      };
    },

    async refresh(refreshToken: string) {
      const tokenHash = hashToken(refreshToken);
      const stored = await prisma.refreshToken.findFirst({
        where: {
          tokenHash,
          revokedAt: null,
          expiresAt: {
            gt: new Date()
          }
        },
        include: {
          user: true
        }
      });

      if (!stored) {
        return null;
      }

      await prisma.refreshToken.update({
        where: { id: stored.id },
        data: { revokedAt: new Date() }
      });

      const session = await issueSession(stored.user, stored.id);
      return {
        user: {
          id: stored.user.id,
          email: stored.user.email,
          role: stored.user.role
        },
        ...session
      };
    },

    async logout(input: { refreshToken?: string; accessToken?: string }) {
      if (input.refreshToken) {
        await prisma.refreshToken.updateMany({
          where: {
            tokenHash: hashToken(input.refreshToken),
            revokedAt: null
          },
          data: {
            revokedAt: new Date()
          }
        });
      }

      if (!input.accessToken) {
        return;
      }

      const exp = getTokenExpiryEpochSeconds(input.accessToken);
      if (!exp) {
        return;
      }

      const ttlSeconds = exp - Math.floor(Date.now() / 1000);
      const payload = JSON.parse(
        Buffer.from(input.accessToken.split(".")[1] ?? "", "base64url").toString("utf8")
      ) as { jti?: string };

      if (payload.jti && ttlSeconds > 0) {
        await deps.redis.set(`blacklist:access:${payload.jti}`, "1", "EX", ttlSeconds);
      }
    }
  };
}
