import { OrderStatus, type PrismaClient } from "@prisma/client";
import type Redis from "ioredis";
import type { Producer } from "kafkajs";
import type { Logger } from "pino";
import {
  ORDER_TOPICS,
  acquireLock,
  buildOrderEvent,
  cacheOrderSnapshot,
  connectConsumer,
  createKafkaClient,
  markEventProcessedIfNew,
  releaseLock
} from "@ordersystem/shared";
import { isTerminalStatus, nextLifecycleStatuses } from "./lifecycle";
import type { ProcessingEnv } from "./env";

type OrderCreatedEvent = {
  eventId: string;
  correlationId: string;
  payload: {
    orderId: string;
    userId: string;
  };
};

const CONSUMER_GROUP = "processing-service";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function publishStatusUpdate(
  prisma: PrismaClient,
  producer: Producer,
  redis: Redis,
  orderId: string,
  previousStatus: OrderStatus,
  currentStatus: OrderStatus,
  correlationId: string,
  logger: Logger
) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      items: true
    }
  });

  if (!order) {
    return;
  }

  const event = buildOrderEvent({
    eventType: "order.status.updated",
    aggregateId: order.id,
    correlationId,
    producer: "processing-service",
    payload: {
      orderId: order.id,
      userId: order.userId,
      previousStatus,
      currentStatus,
      updatedAt: order.updatedAt.toISOString()
    }
  });

  const topic = currentStatus === OrderStatus.DELIVERED ? ORDER_TOPICS.completed : ORDER_TOPICS.processing;
  await producer.send({
    topic,
    messages: [
      {
        key: order.id,
        value: JSON.stringify(event)
      }
    ]
  });

  try {
    await cacheOrderSnapshot(redis, order.id, {
      id: order.id,
      userId: order.userId,
      status: order.status,
      totalAmount: order.totalAmount.toNumber(),
      cancelledAt: order.cancelledAt?.toISOString() ?? null,
      createdAt: order.createdAt.toISOString(),
      updatedAt: order.updatedAt.toISOString(),
      items: order.items.map((item) => ({
        id: item.id,
        sku: item.sku,
        name: item.name,
        quantity: item.quantity,
        unitPrice: item.unitPrice.toNumber()
      }))
    });
  } catch (error) {
    logger.warn({ error, orderId }, "Could not update Redis cache for order");
  }
}

async function publishFailure(
  prisma: PrismaClient,
  producer: Producer,
  orderId: string,
  correlationId: string,
  failedStage: OrderStatus,
  retryCount: number,
  reason: string
) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) {
    return;
  }

  await prisma.order.update({
    where: { id: orderId },
    data: {
      status: OrderStatus.FAILED
    }
  });

  const event = buildOrderEvent({
    eventType: "order.failed",
    aggregateId: order.id,
    correlationId,
    producer: "processing-service",
    payload: {
      orderId: order.id,
      userId: order.userId,
      failedStage,
      reason,
      retryCount,
      updatedAt: new Date().toISOString()
    }
  });

  await producer.send({
    topic: ORDER_TOPICS.failed,
    messages: [{ key: order.id, value: JSON.stringify(event) }]
  });

  await producer.send({
    topic: ORDER_TOPICS.dlq,
    messages: [{ key: order.id, value: JSON.stringify(event) }]
  });
}

async function advanceOrderLifecycle(
  prisma: PrismaClient,
  redis: Redis,
  producer: Producer,
  orderId: string,
  correlationId: string,
  delayMs: number,
  logger: Logger
) {
  const current = await prisma.order.findUnique({ where: { id: orderId } });
  if (!current || isTerminalStatus(current.status)) {
    return;
  }

  const statuses = nextLifecycleStatuses(current.status);
  let previousStatus = current.status;

  for (const status of statuses) {
    await sleep(delayMs);

    const latest = await prisma.order.findUnique({ where: { id: orderId } });
    if (!latest || latest.status === OrderStatus.CANCELLED || isTerminalStatus(latest.status)) {
      logger.info({ orderId, status: latest?.status }, "Skipping lifecycle advancement for terminal order");
      return;
    }

    const updated = await prisma.order.update({
      where: { id: orderId },
      data: {
        status
      }
    });

    await publishStatusUpdate(
      prisma,
      producer,
      redis,
      updated.id,
      previousStatus,
      updated.status,
      correlationId,
      logger
    );

    previousStatus = updated.status;
  }
}

export async function startProcessingConsumer(deps: {
  prisma: PrismaClient;
  redis: Redis;
  producer: Producer;
  env: ProcessingEnv;
  logger: Logger;
}): Promise<void> {
  const kafka = createKafkaClient("processing-service", deps.env.KAFKA_BROKERS);
  const consumer = await connectConsumer(
    kafka.consumer({ groupId: CONSUMER_GROUP }),
    [ORDER_TOPICS.created]
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

      const event = JSON.parse(message.value.toString()) as OrderCreatedEvent;
      const lockKey = `lock:order:${event.payload.orderId}`;
      const token = await acquireLock(deps.redis, lockKey, deps.env.PROCESSING_LOCK_TTL_MS);

      if (!token) {
        deps.logger.warn({ orderId: event.payload.orderId }, "Order lock already held, skipping duplicate work");
        await consumer.commitOffsets([
          {
            topic,
            partition,
            offset: (BigInt(message.offset) + 1n).toString()
          }
        ]);
        return;
      }

      let shouldCommit = false;
      try {
        for (let attempt = 1; attempt <= deps.env.PROCESSING_RETRY_MAX; attempt += 1) {
          try {
            await advanceOrderLifecycle(
              deps.prisma,
              deps.redis,
              deps.producer,
              event.payload.orderId,
              event.correlationId,
              deps.env.PROCESSING_DELAY_MS,
              deps.logger
            );

            await deps.prisma.$transaction(async (tx) => {
              await markEventProcessedIfNew(tx, event.eventId, CONSUMER_GROUP);
            });

            shouldCommit = true;
            break;
          } catch (error) {
            deps.logger.error(
              { error, orderId: event.payload.orderId, attempt },
              "Processing attempt failed"
            );

            if (attempt === deps.env.PROCESSING_RETRY_MAX) {
              await publishFailure(
                deps.prisma,
                deps.producer,
                event.payload.orderId,
                event.correlationId,
                OrderStatus.CREATED,
                attempt,
                error instanceof Error ? error.message : "Unknown processing error"
              );
              await deps.prisma.$transaction(async (tx) => {
                await markEventProcessedIfNew(tx, event.eventId, CONSUMER_GROUP);
              });
              shouldCommit = true;
            } else {
              await sleep(Math.pow(2, attempt) * 250);
            }
          }
        }
      } finally {
        await releaseLock(deps.redis, lockKey, token);
      }

      if (shouldCommit) {
        await consumer.commitOffsets([
          {
            topic,
            partition,
            offset: (BigInt(message.offset) + 1n).toString()
          }
        ]);
      }
    }
  });

}

export async function resumeStalledOrders(deps: {
  prisma: PrismaClient;
  redis: Redis;
  producer: Producer;
  env: ProcessingEnv;
  logger: Logger;
}) {
  const stalled = await deps.prisma.order.findMany({
    where: {
      status: {
        in: [OrderStatus.CREATED, OrderStatus.ACCEPTED, OrderStatus.PREPARING, OrderStatus.OUT_FOR_DELIVERY]
      }
    },
    orderBy: { updatedAt: "asc" },
    take: 25
  });

  for (const order of stalled) {
    const lockKey = `lock:order:${order.id}`;
    const token = await acquireLock(deps.redis, lockKey, deps.env.PROCESSING_LOCK_TTL_MS);
    if (!token) {
      continue;
    }

    void advanceOrderLifecycle(
      deps.prisma,
      deps.redis,
      deps.producer,
      order.id,
      `resume-${order.id}`,
      deps.env.PROCESSING_DELAY_MS,
      deps.logger
    ).finally(async () => {
      await releaseLock(deps.redis, lockKey, token);
    });
  }
}
