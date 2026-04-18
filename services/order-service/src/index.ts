import { createKafkaClient, createLogger, connectProducer, prisma } from "@ordersystem/shared";
import { createApp } from "./app";
import { orderEnv } from "./env";
import { startOutboxPublisher } from "./outbox-publisher";

async function bootstrap() {
  const logger = createLogger("order-service", orderEnv.LOG_LEVEL);
  const kafka = createKafkaClient("order-service", orderEnv.KAFKA_BROKERS);
  const producer = await connectProducer(kafka.producer());
  const app = createApp(orderEnv);

  startOutboxPublisher({
    prisma,
    producer,
    logger,
    intervalMs: orderEnv.OUTBOX_POLL_INTERVAL_MS
  });

  app.listen(orderEnv.PORT, () => {
    logger.info({ port: orderEnv.PORT }, "order-service listening");
  });
}

void bootstrap();
