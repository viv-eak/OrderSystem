import { z } from "zod";
import { baseEnvSchema } from "@ordersystem/shared";

export const authEnv = baseEnvSchema.extend({
  PORT: z.coerce.number().default(4001),
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),
  LOGIN_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60)
}).parse(process.env);

export type AuthEnv = typeof authEnv;
