import { z } from "zod";
import { baseEnvSchema } from "@ordersystem/shared";

export const orderEnv = baseEnvSchema.extend({
  PORT: z.coerce.number().default(4002),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2000)
}).parse(process.env);

export type OrderEnv = typeof orderEnv;
