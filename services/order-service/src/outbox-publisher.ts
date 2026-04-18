import { OutboxStatus, type PrismaClient } from "@prisma/client";
import type { Producer } from "kafkajs";
import type { Logger } from "pino";

export function startOutboxPublisher(deps: {
  prisma: PrismaClient;
  producer: Producer;
  logger: Logger;
  intervalMs: number;
}) {
  const { prisma, producer, logger, intervalMs } = deps;

  const timer = setInterval(async () => {
    try {
      const pending = await prisma.outboxEvent.findMany({
        where: {
          status: {
            in: [OutboxStatus.PENDING, OutboxStatus.FAILED]
          },
          nextAttemptAt: {
            lte: new Date()
          }
        },
        orderBy: { createdAt: "asc" },
        take: 20
      });

      for (const entry of pending) {
        try {
          await producer.send({
            topic: entry.topic,
            messages: [
              {
                key: entry.eventKey,
                value: JSON.stringify(entry.payload)
              }
            ]
          });

          await prisma.outboxEvent.update({
            where: { id: entry.id },
            data: {
              status: OutboxStatus.PUBLISHED
            }
          });
        } catch (error) {
          const attemptCount = entry.attemptCount + 1;
          const backoffMs = Math.min(60_000, Math.pow(2, attemptCount) * 1_000);
          logger.error({ error, outboxEventId: entry.id }, "Failed to publish outbox event");

          await prisma.outboxEvent.update({
            where: { id: entry.id },
            data: {
              status: OutboxStatus.FAILED,
              attemptCount,
              nextAttemptAt: new Date(Date.now() + backoffMs)
            }
          });
        }
      }
    } catch (error) {
      logger.error({ error }, "Outbox publisher poll failed");
    }
  }, intervalMs);

  return () => clearInterval(timer);
}
