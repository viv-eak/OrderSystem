import type { PrismaClient } from "@prisma/client";
import type Redis from "ioredis";
import type { Logger } from "pino";
import {
  ORDER_TOPICS,
  connectConsumer,
  createKafkaClient,
  markEventProcessedIfNew,
  publishSocketEvent
} from "@ordersystem/shared";
import type { NotificationEnv } from "./env";

const CONSUMER_GROUP = "notification-service";

type NotificationEvent = {
  eventId: string;
  eventType: string;
  payload: {
    orderId: string;
    userId: string;
    currentStatus?: string;
    failedStage?: string;
    reason?: string;
    updatedAt: string;
  };
};

export function buildUserEvent(event: NotificationEvent) {
  return {
    userId: event.payload.userId,
    event: "order.status.updated",
    data: {
      orderId: event.payload.orderId,
      status: event.payload.currentStatus ?? event.payload.failedStage ?? "UNKNOWN",
      timestamp: event.payload.updatedAt,
      reason: event.payload.reason ?? null
    }
  };
}

export async function startNotificationConsumer(deps: {
  prisma: PrismaClient;
  redis: Redis;
  env: NotificationEnv;
  logger: Logger;
}): Promise<void> {
  const kafka = createKafkaClient("notification-service", deps.env.KAFKA_BROKERS);
  const consumer = await connectConsumer(
    kafka.consumer({ groupId: CONSUMER_GROUP }),
    [ORDER_TOPICS.processing, ORDER_TOPICS.completed, ORDER_TOPICS.failed]
  );

  await consumer.run({
    autoCommit: false,
    eachMessage: async ({ topic, partition, message }) => {
      if (!message.value) {
        await consumer.commitOffsets([
          {
            topic,
            partition,
            offset: (BigInt(message.offset) + 1n).toString()
          }
        ]);
        return;
      }

      const event = JSON.parse(message.value.toString()) as NotificationEvent;

      const processed = await deps.prisma.$transaction(async (tx) => {
        const isNew = await markEventProcessedIfNew(tx, event.eventId, CONSUMER_GROUP);
        if (!isNew) {
          return false;
        }

        await tx.notification.create({
          data: {
            userId: event.payload.userId,
            orderId: event.payload.orderId,
            type: event.eventType,
            payload: event,
            deliveredAt: new Date()
          }
        });

        return true;
      });

      if (processed) {
        await publishSocketEvent(deps.redis, deps.env.SOCKET_EVENTS_CHANNEL, buildUserEvent(event));
      }

      await consumer.commitOffsets([
        {
          topic,
          partition,
          offset: (BigInt(message.offset) + 1n).toString()
        }
      ]);
    }
  });
}
