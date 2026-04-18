import { OrderStatus, Role, type PrismaClient } from "@prisma/client";
import type Redis from "ioredis";
import {
  ORDER_TOPICS,
  buildOrderEvent,
  cacheOrderSnapshot,
  getCachedOrderSnapshot,
  removeCachedOrderSnapshot
} from "@ordersystem/shared";

type OrderViewer = {
  userId: string;
  email: string;
  role: Role;
  jti: string;
};

type CreateOrderInput = {
  items: Array<{
    sku: string;
    name: string;
    quantity: number;
    unitPrice: number;
  }>;
};

function toOrderSnapshot(order: {
  id: string;
  userId: string;
  status: OrderStatus;
  totalAmount: { toNumber(): number } | number;
  cancelledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  items: Array<{
    id: string;
    sku: string;
    name: string;
    quantity: number;
    unitPrice: { toNumber(): number } | number;
  }>;
}) {
  return {
    id: order.id,
    userId: order.userId,
    status: order.status,
    totalAmount:
      typeof order.totalAmount === "number" ? order.totalAmount : order.totalAmount.toNumber(),
    cancelledAt: order.cancelledAt?.toISOString() ?? null,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
    items: order.items.map((item) => ({
      id: item.id,
      sku: item.sku,
      name: item.name,
      quantity: item.quantity,
      unitPrice: typeof item.unitPrice === "number" ? item.unitPrice : item.unitPrice.toNumber()
    }))
  };
}

function ensureCanAccess(viewer: OrderViewer, orderUserId: string) {
  return viewer.role === Role.ADMIN || viewer.userId === orderUserId;
}

export function canCancelOrder(status: OrderStatus) {
  const cancellableStatuses: OrderStatus[] = [
    OrderStatus.CREATED,
    OrderStatus.ACCEPTED,
    OrderStatus.PREPARING
  ];

  return cancellableStatuses.includes(status);
}

export function createOrderService(deps: { prisma: PrismaClient; redis: Redis }) {
  const { prisma, redis } = deps;

  return {
    async createOrder(viewer: OrderViewer, input: CreateOrderInput, correlationId: string) {
      const totalAmount = input.items.reduce(
        (sum, item) => sum + item.quantity * item.unitPrice,
        0
      );

      const created = await prisma.$transaction(async (tx) => {
        const order = await tx.order.create({
          data: {
            userId: viewer.userId,
            status: OrderStatus.CREATED,
            totalAmount,
            items: {
              create: input.items.map((item) => ({
                sku: item.sku,
                name: item.name,
                quantity: item.quantity,
                unitPrice: item.unitPrice
              }))
            }
          },
          include: {
            items: true
          }
        });

        const event = buildOrderEvent({
          eventType: "order.created",
          aggregateId: order.id,
          correlationId,
          producer: "order-service",
          payload: {
            orderId: order.id,
            userId: viewer.userId,
            items: input.items,
            status: order.status,
            createdAt: order.createdAt.toISOString()
          }
        });

        await tx.outboxEvent.create({
          data: {
            aggregateId: order.id,
            topic: ORDER_TOPICS.created,
            eventKey: order.id,
            payload: event
          }
        });

        return order;
      });

      const snapshot = toOrderSnapshot(created);
      try {
        await cacheOrderSnapshot(redis, created.id, snapshot);
      } catch {
        // Fall back to the database on the next read when Redis is unavailable.
      }

      return snapshot;
    },

    async getOrderById(viewer: OrderViewer, orderId: string) {
      try {
        const cached = await getCachedOrderSnapshot<ReturnType<typeof toOrderSnapshot>>(redis, orderId);
        if (cached && ensureCanAccess(viewer, cached.userId)) {
          return cached;
        }
      } catch {
        // Use the database path when Redis is unavailable.
      }

      const order = await prisma.order.findUnique({
        where: { id: orderId },
        include: {
          items: true
        }
      });

      if (!order || !ensureCanAccess(viewer, order.userId)) {
        return null;
      }

      const snapshot = toOrderSnapshot(order);
      try {
        await cacheOrderSnapshot(redis, order.id, snapshot);
      } catch {
        // Best effort cache warm.
      }

      return snapshot;
    },

    async listOrders(viewer: OrderViewer) {
      const orders = await prisma.order.findMany({
        where: viewer.role === Role.ADMIN ? undefined : { userId: viewer.userId },
        orderBy: { createdAt: "desc" },
        include: {
          items: true
        }
      });

      return orders.map((order) => toOrderSnapshot(order));
    },

    async cancelOrder(viewer: OrderViewer, orderId: string, correlationId: string) {
      const result = await prisma.$transaction(async (tx) => {
        const order = await tx.order.findUnique({
          where: { id: orderId },
          include: {
            items: true
          }
        });

        if (!order || !ensureCanAccess(viewer, order.userId)) {
          return null;
        }

        if (!canCancelOrder(order.status)) {
          return { order, cancelled: false as const };
        }

        const updated = await tx.order.update({
          where: { id: orderId },
          data: {
            status: OrderStatus.CANCELLED,
            cancelledAt: new Date()
          },
          include: {
            items: true
          }
        });

        const event = buildOrderEvent({
          eventType: "order.status.updated",
          aggregateId: updated.id,
          correlationId,
          producer: "order-service",
          payload: {
            orderId: updated.id,
            userId: updated.userId,
            previousStatus: order.status,
            currentStatus: updated.status,
            updatedAt: updated.updatedAt.toISOString()
          }
        });

        await tx.outboxEvent.create({
          data: {
            aggregateId: updated.id,
            topic: ORDER_TOPICS.processing,
            eventKey: updated.id,
            payload: event
          }
        });

        return { order: updated, cancelled: true as const };
      });

      if (!result) {
        return null;
      }

      const snapshot = toOrderSnapshot(result.order);
      try {
        if (result.cancelled) {
          await cacheOrderSnapshot(redis, orderId, snapshot);
        } else {
          await removeCachedOrderSnapshot(redis, orderId);
        }
      } catch {
        // Cache updates are best effort.
      }

      return {
        ...snapshot,
        cancelled: result.cancelled
      };
    }
  };
}
