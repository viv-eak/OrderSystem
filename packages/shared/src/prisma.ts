import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __orderSystemPrisma__: PrismaClient | undefined;
}

export const prisma =
  global.__orderSystemPrisma__ ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"]
  });

if (process.env.NODE_ENV !== "production") {
  global.__orderSystemPrisma__ = prisma;
}
