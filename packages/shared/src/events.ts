import crypto from "node:crypto";
import { OrderStatus } from "@prisma/client";

export const ORDER_TOPICS = {
  created: "order_created",
  processing: "order_processing",
  completed: "order_completed",
  failed: "order_failed",
  dlq: "order_dlt"
} as const;

export type OrderTopic = (typeof ORDER_TOPICS)[keyof typeof ORDER_TOPICS];

export type OrderItemInput = {
  sku: string;
  name: string;
  quantity: number;
  unitPrice: number;
};

export type EventEnvelope<TPayload> = {
  eventId: string;
  eventType: string;
  occurredAt: string;
  aggregateType: "order";
  aggregateId: string;
  correlationId: string;
  causationId: string | null;
  version: number;
  producer: string;
  payload: TPayload;
};

export type OrderCreatedPayload = {
  orderId: string;
  userId: string;
  items: OrderItemInput[];
  status: OrderStatus;
  createdAt: string;
};

export type OrderStatusUpdatedPayload = {
  orderId: string;
  userId: string;
  previousStatus: OrderStatus;
  currentStatus: OrderStatus;
  updatedAt: string;
};

export type OrderFailedPayload = {
  orderId: string;
  userId: string;
  failedStage: OrderStatus;
  reason: string;
  retryCount: number;
  updatedAt: string;
};

export function buildOrderEvent<TPayload>(input: {
  eventType: string;
  aggregateId: string;
  correlationId?: string;
  causationId?: string | null;
  producer: string;
  payload: TPayload;
}): EventEnvelope<TPayload> {
  return {
    eventId: crypto.randomUUID(),
    eventType: input.eventType,
    occurredAt: new Date().toISOString(),
    aggregateType: "order",
    aggregateId: input.aggregateId,
    correlationId: input.correlationId ?? crypto.randomUUID(),
    causationId: input.causationId ?? null,
    version: 1,
    producer: input.producer,
    payload: input.payload
  };
}
