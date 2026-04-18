import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { Role } from "@prisma/client";
import type { Request } from "express";

export type AccessTokenPayload = {
  sub: string;
  email: string;
  role: Role;
  jti: string;
};

export type AuthenticatedUser = {
  userId: string;
  email: string;
  role: Role;
  jti: string;
};

export function hashPassword(password: string) {
  return bcrypt.hash(password, 12);
}

export function verifyPassword(password: string, passwordHash: string) {
  return bcrypt.compare(password, passwordHash);
}

export function hashToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function generateOpaqueToken() {
  return crypto.randomBytes(48).toString("hex");
}

export function createAccessToken(payload: Omit<AccessTokenPayload, "jti"> & { jti?: string }, config: {
  secret: string;
  expiresInMinutes: number;
}) {
  const jti = payload.jti ?? crypto.randomUUID();
  return {
    token: jwt.sign(
      {
        sub: payload.sub,
        email: payload.email,
        role: payload.role,
        jti
      },
      config.secret,
      { expiresIn: `${config.expiresInMinutes}m` }
    ),
    jti
  };
}

export function verifyAccessToken(token: string, secret: string) {
  return jwt.verify(token, secret) as AccessTokenPayload;
}

export function getTokenExpiryEpochSeconds(token: string) {
  const decoded = jwt.decode(token) as { exp?: number } | null;
  return decoded?.exp ?? null;
}

export function extractBearerToken(req: Pick<Request, "headers">) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return null;
  }

  return authHeader.slice("Bearer ".length);
}

export function userFromGatewayHeaders(req: Pick<Request, "headers">): AuthenticatedUser | null {
  const userId = req.headers["x-user-id"];
  const email = req.headers["x-user-email"];
  const role = req.headers["x-user-role"];
  const jti = req.headers["x-user-jti"];

  if (
    typeof userId !== "string" ||
    typeof email !== "string" ||
    typeof role !== "string" ||
    typeof jti !== "string"
  ) {
    return null;
  }

  return {
    userId,
    email,
    role: role as Role,
    jti
  };
}
