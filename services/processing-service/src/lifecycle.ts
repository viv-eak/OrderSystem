import { OrderStatus } from "@prisma/client";

export function nextLifecycleStatuses(status: OrderStatus) {
  switch (status) {
    case OrderStatus.CREATED:
      return [OrderStatus.ACCEPTED, OrderStatus.PREPARING, OrderStatus.OUT_FOR_DELIVERY, OrderStatus.DELIVERED];
    case OrderStatus.ACCEPTED:
      return [OrderStatus.PREPARING, OrderStatus.OUT_FOR_DELIVERY, OrderStatus.DELIVERED];
    case OrderStatus.PREPARING:
      return [OrderStatus.OUT_FOR_DELIVERY, OrderStatus.DELIVERED];
    case OrderStatus.OUT_FOR_DELIVERY:
      return [OrderStatus.DELIVERED];
    default:
      return [];
  }
}

export function isTerminalStatus(status: OrderStatus) {
  const terminalStatuses: OrderStatus[] = [
    OrderStatus.DELIVERED,
    OrderStatus.CANCELLED,
    OrderStatus.FAILED
  ];

  return terminalStatuses.includes(status);
}
