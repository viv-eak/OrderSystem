import { createLogger, createRedisClient, prisma } from "@ordersystem/shared";
import { createApp } from "./app";
import { notificationEnv } from "./env";
import { startNotificationConsumer } from "./notifier";

async function bootstrap() {
  const logger = createLogger("notification-service", notificationEnv.LOG_LEVEL);
  const redis = createRedisClient(notificationEnv.REDIS_URL);
  const app = createApp(notificationEnv);

  await startNotificationConsumer({
    prisma,
    redis,
    env: notificationEnv,
    logger
  });

  app.listen(notificationEnv.PORT, () => {
    logger.info({ port: notificationEnv.PORT }, "notification-service listening");
  });
}

void bootstrap();
