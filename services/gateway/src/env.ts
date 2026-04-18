import { z } from "zod";
import { baseEnvSchema } from "@ordersystem/shared";

export const gatewayEnv = baseEnvSchema.extend({
  PORT: z.coerce.number().default(4000),
  AUTH_SERVICE_URL: z.string().url().default("http://localhost:4001"),
  ORDER_SERVICE_URL: z.string().url().default("http://localhost:4002"),
  API_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
  API_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  SOCKET_EVENTS_CHANNEL: z.string().default("ws:user-events"),
  CORS_ORIGINS: z.string().default("http://localhost:5173,http://localhost:4173")
}).parse(process.env);

export type GatewayEnv = typeof gatewayEnv;
