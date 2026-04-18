import { z } from "zod";

export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  KAFKA_BROKERS: z.string().min(1),
  ACCESS_TOKEN_SECRET: z.string().min(16),
  REFRESH_TOKEN_SECRET: z.string().min(16),
  ACCESS_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(14),
  AUTH_SERVICE_URL: z.string().url().optional(),
  ORDER_SERVICE_URL: z.string().url().optional(),
  PROCESSING_SERVICE_URL: z.string().url().optional(),
  NOTIFICATION_SERVICE_URL: z.string().url().optional(),
  GATEWAY_URL: z.string().url().optional()
});

export type BaseEnv = z.infer<typeof baseEnvSchema>;

export function parseEnv<T extends z.ZodRawShape>(shape?: T) {
  const schema = shape ? baseEnvSchema.extend(shape) : baseEnvSchema;
  return schema.parse(process.env);
}
