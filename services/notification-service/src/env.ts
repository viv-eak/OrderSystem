import { z } from "zod";
import { baseEnvSchema } from "@ordersystem/shared";

export const notificationEnv = baseEnvSchema.extend({
  PORT: z.coerce.number().default(4004),
  SOCKET_EVENTS_CHANNEL: z.string().default("ws:user-events")
}).parse(process.env);

export type NotificationEnv = typeof notificationEnv;
