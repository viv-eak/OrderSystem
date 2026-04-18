import {
  connectProducer,
  createKafkaClient,
  createLogger,
  createRedisClient,
  prisma
} from "@ordersystem/shared";
import { createApp } from "./app";
import { processingEnv } from "./env";
import { resumeStalledOrders, startProcessingConsumer } from "./processor";

async function bootstrap() {
  const logger = createLogger("processing-service", processingEnv.LOG_LEVEL);
  const redis = createRedisClient(processingEnv.REDIS_URL);
  const kafka = createKafkaClient("processing-service-producer", processingEnv.KAFKA_BROKERS);
  const producer = await connectProducer(kafka.producer());
  const app = createApp(processingEnv);

  await startProcessingConsumer({
    prisma,
    redis,
    producer,
    env: processingEnv,
    logger
  });

  await resumeStalledOrders({
    prisma,
    redis,
    producer,
    env: processingEnv,
    logger
  });

  app.listen(processingEnv.PORT, () => {
    logger.info({ port: processingEnv.PORT }, "processing-service listening");
  });
}

void bootstrap();
