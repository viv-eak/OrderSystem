import { z } from "zod";
import { baseEnvSchema } from "@ordersystem/shared";

export const processingEnv = baseEnvSchema.extend({
  PORT: z.coerce.number().default(4003),
  PROCESSING_DELAY_MS: z.coerce.number().int().positive().default(5000),
  PROCESSING_RETRY_MAX: z.coerce.number().int().positive().default(3),
  PROCESSING_LOCK_TTL_MS: z.coerce.number().int().positive().default(15000)
}).parse(process.env);

export type ProcessingEnv = typeof processingEnv;
