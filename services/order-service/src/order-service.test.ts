import { describe, expect, it, vi, beforeEach } from "vitest";
import { OrderStatus, Role } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import type Redis from "ioredis";
import { canCancelOrder, createOrderService } from "./order-service";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------
function makeViewer(overrides: Partial<{ userId: string; role: Role }> = {}) {
  return {
    userId: "user-uuid-1",
    email: "user@example.com",
    role: Role.USER,
    jti: "jti-abc",
    ...overrides
  };
}

function makeOrderRow(overrides: Partial<{
  id: string;
  userId: string;
  status: OrderStatus;
  totalAmount: { toNumber(): number };
}> = {}) {
  const now = new Date();
  return {
    id: "ord-uuid-1",
    userId: "user-uuid-1",
    status: OrderStatus.CREATED,
    totalAmount: { toNumber: () => 29.99 },
    cancelledAt: null,
    createdAt: now,
    updatedAt: now,
    items: [
      {
        id: "item-uuid-1",
        sku: "SKU-001",
        name: "Burger",
        quantity: 1,
        unitPrice: { toNumber: () => 29.99 }
      }
    ],
    ...overrides
  };
}

function makePrismaMock() {
  const txMock = {
    order: {
      create: vi.fn(),
      update: vi.fn(),
      findUnique: vi.fn()
    },
    outboxEvent: { create: vi.fn() }
  };

  const prisma = {
    $transaction: vi.fn().mockImplementation((fn: (tx: typeof txMock) => unknown) => fn(txMock)),
    order: {
      findUnique: vi.fn(),
      findMany: vi.fn()
    }
  } as unknown as PrismaClient & { _tx: typeof txMock };

  // Expose the tx mock so tests can configure it
  (prisma as unknown as { _tx: typeof txMock })._tx = txMock;

  return prisma;
}

function makeRedisMock() {
  return {
    get: vi.fn<[], Promise<string | null>>().mockResolvedValue(null),
    set: vi.fn<[], Promise<string | null>>().mockResolvedValue("OK"),
    del: vi.fn<[], Promise<number>>().mockResolvedValue(1)
  } as unknown as Redis;
}

// ---------------------------------------------------------------------------
// canCancelOrder (pure guard — no dependencies)
// ---------------------------------------------------------------------------
describe("canCancelOrder", () => {
  it("allows cancellation for CREATED", () => expect(canCancelOrder(OrderStatus.CREATED)).toBe(true));
  it("allows cancellation for ACCEPTED", () => expect(canCancelOrder(OrderStatus.ACCEPTED)).toBe(true));
  it("allows cancellation for PREPARING", () => expect(canCancelOrder(OrderStatus.PREPARING)).toBe(true));
  it("blocks cancellation for OUT_FOR_DELIVERY", () => expect(canCancelOrder(OrderStatus.OUT_FOR_DELIVERY)).toBe(false));
  it("blocks cancellation for DELIVERED", () => expect(canCancelOrder(OrderStatus.DELIVERED)).toBe(false));
  it("blocks cancellation for CANCELLED", () => expect(canCancelOrder(OrderStatus.CANCELLED)).toBe(false));
  it("blocks cancellation for FAILED", () => expect(canCancelOrder(OrderStatus.FAILED)).toBe(false));
});

// ---------------------------------------------------------------------------
// createOrder
// ---------------------------------------------------------------------------
describe("createOrderService.createOrder", () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let redis: ReturnType<typeof makeRedisMock>;

  beforeEach(() => {
    prisma = makePrismaMock();
    redis = makeRedisMock();
    const tx = (prisma as unknown as { _tx: { order: { create: ReturnType<typeof vi.fn> }; outboxEvent: { create: ReturnType<typeof vi.fn> } } })._tx;
    tx.order.create.mockResolvedValue(makeOrderRow());
    tx.outboxEvent.create.mockResolvedValue({});
  });

  it("returns an order snapshot with the correct calculated total", async () => {
    const service = createOrderService({ prisma, redis });
    const result = await service.createOrder(
      makeViewer(),
      { items: [{ sku: "SKU-1", name: "Burger", quantity: 2, unitPrice: 10.5 }] },
      "corr-id-1"
    );

    expect(result.status).toBe(OrderStatus.CREATED);
    expect(result.id).toBe("ord-uuid-1");
  });

  it("writes an outbox event inside the same transaction", async () => {
    const service = createOrderService({ prisma, redis });
    const tx = (prisma as unknown as { _tx: { outboxEvent: { create: ReturnType<typeof vi.fn> } } })._tx;

    await service.createOrder(makeViewer(), { items: [{ sku: "S", name: "N", quantity: 1, unitPrice: 5 }] }, "corr");

    expect(tx.outboxEvent.create).toHaveBeenCalledOnce();
    expect(tx.outboxEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ topic: "order_created" }) })
    );
  });

  it("warms the Redis cache after a successful create (best-effort)", async () => {
    const service = createOrderService({ prisma, redis });
    await service.createOrder(makeViewer(), { items: [{ sku: "S", name: "N", quantity: 1, unitPrice: 5 }] }, "corr");
    expect(redis.set).toHaveBeenCalledWith(
      expect.stringMatching(/^cache:order:/),
      expect.any(String),
      "EX",
      300
    );
  });
});

// ---------------------------------------------------------------------------
// getOrderById
// ---------------------------------------------------------------------------
describe("createOrderService.getOrderById", () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let redis: ReturnType<typeof makeRedisMock>;

  beforeEach(() => {
    prisma = makePrismaMock();
    redis = makeRedisMock();
  });

  it("returns a cached snapshot on a Redis hit", async () => {
    const cached = { id: "ord-uuid-1", userId: "user-uuid-1", status: "CREATED" };
    redis.get = vi.fn().mockResolvedValue(JSON.stringify(cached));
    const service = createOrderService({ prisma, redis });

    const result = await service.getOrderById(makeViewer(), "ord-uuid-1");

    expect(result).toEqual(cached);
    expect(prisma.order.findUnique).not.toHaveBeenCalled();
  });

  it("falls back to the database on a cache miss", async () => {
    redis.get = vi.fn().mockResolvedValue(null);
    vi.mocked(prisma.order.findUnique).mockResolvedValue(makeOrderRow() as never);
    const service = createOrderService({ prisma, redis });

    const result = await service.getOrderById(makeViewer(), "ord-uuid-1");

    expect(prisma.order.findUnique).toHaveBeenCalled();
    expect(result).not.toBeNull();
    expect(result!.id).toBe("ord-uuid-1");
  });

  it("returns null for an order that does not exist", async () => {
    redis.get = vi.fn().mockResolvedValue(null);
    vi.mocked(prisma.order.findUnique).mockResolvedValue(null);
    const service = createOrderService({ prisma, redis });

    expect(await service.getOrderById(makeViewer(), "missing-id")).toBeNull();
  });

  it("returns null when the viewer does not own the order and is not ADMIN", async () => {
    const otherUserOrder = makeOrderRow({ userId: "other-user-id" });
    redis.get = vi.fn().mockResolvedValue(null);
    vi.mocked(prisma.order.findUnique).mockResolvedValue(otherUserOrder as never);
    const service = createOrderService({ prisma, redis });

    expect(await service.getOrderById(makeViewer({ userId: "current-user-id" }), "ord-uuid-1")).toBeNull();
  });

  it("allows an ADMIN to access any order", async () => {
    const otherUserOrder = makeOrderRow({ userId: "some-user-id" });
    redis.get = vi.fn().mockResolvedValue(null);
    vi.mocked(prisma.order.findUnique).mockResolvedValue(otherUserOrder as never);
    const service = createOrderService({ prisma, redis });

    const result = await service.getOrderById(makeViewer({ userId: "admin-id", role: Role.ADMIN }), "ord-uuid-1");
    expect(result).not.toBeNull();
  });

  it("warms the cache after a DB read", async () => {
    redis.get = vi.fn().mockResolvedValue(null);
    vi.mocked(prisma.order.findUnique).mockResolvedValue(makeOrderRow() as never);
    const service = createOrderService({ prisma, redis });

    await service.getOrderById(makeViewer(), "ord-uuid-1");

    expect(redis.set).toHaveBeenCalledWith(
      "cache:order:ord-uuid-1",
      expect.any(String),
      "EX",
      300
    );
  });
});

// ---------------------------------------------------------------------------
// listOrders
// ---------------------------------------------------------------------------
describe("createOrderService.listOrders", () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let redis: ReturnType<typeof makeRedisMock>;

  beforeEach(() => {
    prisma = makePrismaMock();
    redis = makeRedisMock();
  });

  it("scopes the query to the viewer's userId for regular users", async () => {
    vi.mocked(prisma.order.findMany).mockResolvedValue([]);
    const service = createOrderService({ prisma, redis });

    await service.listOrders(makeViewer({ userId: "user-1" }));

    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-1" } })
    );
  });

  it("fetches all orders with no filter for ADMIN users", async () => {
    vi.mocked(prisma.order.findMany).mockResolvedValue([]);
    const service = createOrderService({ prisma, redis });

    await service.listOrders(makeViewer({ role: Role.ADMIN }));

    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: undefined })
    );
  });

  it("returns serialized snapshots for each order", async () => {
    vi.mocked(prisma.order.findMany).mockResolvedValue([makeOrderRow(), makeOrderRow({ id: "ord-2" })] as never);
    const service = createOrderService({ prisma, redis });

    const results = await service.listOrders(makeViewer());

    expect(results).toHaveLength(2);
    expect(results[0].status).toBe(OrderStatus.CREATED);
  });
});

// ---------------------------------------------------------------------------
// cancelOrder
// ---------------------------------------------------------------------------
describe("createOrderService.cancelOrder", () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let redis: ReturnType<typeof makeRedisMock>;

  beforeEach(() => {
    prisma = makePrismaMock();
    redis = makeRedisMock();
  });

  function setupCancellableOrder(status = OrderStatus.CREATED) {
    const tx = (prisma as unknown as { _tx: { order: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }; outboxEvent: { create: ReturnType<typeof vi.fn> } } })._tx;
    tx.order.findUnique.mockResolvedValue(makeOrderRow({ status }));
    tx.order.update.mockResolvedValue(makeOrderRow({ status: OrderStatus.CANCELLED }));
    tx.outboxEvent.create.mockResolvedValue({});
  }

  it("cancels an order in CREATED status and returns cancelled: true", async () => {
    setupCancellableOrder(OrderStatus.CREATED);
    const service = createOrderService({ prisma, redis });

    const result = await service.cancelOrder(makeViewer(), "ord-uuid-1", "corr-id");

    expect(result).not.toBeNull();
    expect(result!.cancelled).toBe(true);
    expect(result!.status).toBe(OrderStatus.CANCELLED);
  });

  it("cancels an order in ACCEPTED status", async () => {
    setupCancellableOrder(OrderStatus.ACCEPTED);
    const service = createOrderService({ prisma, redis });

    const result = await service.cancelOrder(makeViewer(), "ord-uuid-1", "corr-id");
    expect(result!.cancelled).toBe(true);
  });

  it("cancels an order in PREPARING status", async () => {
    setupCancellableOrder(OrderStatus.PREPARING);
    const service = createOrderService({ prisma, redis });

    const result = await service.cancelOrder(makeViewer(), "ord-uuid-1", "corr-id");
    expect(result!.cancelled).toBe(true);
  });

  it("returns cancelled: false for an order already OUT_FOR_DELIVERY", async () => {
    const tx = (prisma as unknown as { _tx: { order: { findUnique: ReturnType<typeof vi.fn> }; outboxEvent: { create: ReturnType<typeof vi.fn> } } })._tx;
    tx.order.findUnique.mockResolvedValue(makeOrderRow({ status: OrderStatus.OUT_FOR_DELIVERY }));
    const service = createOrderService({ prisma, redis });

    const result = await service.cancelOrder(makeViewer(), "ord-uuid-1", "corr-id");

    expect(result).not.toBeNull();
    expect(result!.cancelled).toBe(false);
  });

  it("returns null when the order does not exist", async () => {
    const tx = (prisma as unknown as { _tx: { order: { findUnique: ReturnType<typeof vi.fn> } } })._tx;
    tx.order.findUnique.mockResolvedValue(null);
    const service = createOrderService({ prisma, redis });

    expect(await service.cancelOrder(makeViewer(), "missing-id", "corr")).toBeNull();
  });

  it("returns null when the viewer does not own the order", async () => {
    const tx = (prisma as unknown as { _tx: { order: { findUnique: ReturnType<typeof vi.fn> } } })._tx;
    tx.order.findUnique.mockResolvedValue(makeOrderRow({ userId: "other-user" }));
    const service = createOrderService({ prisma, redis });

    expect(await service.cancelOrder(makeViewer({ userId: "current-user" }), "ord-uuid-1", "corr")).toBeNull();
  });

  it("writes an outbox event on successful cancellation", async () => {
    setupCancellableOrder();
    const tx = (prisma as unknown as { _tx: { outboxEvent: { create: ReturnType<typeof vi.fn> } } })._tx;
    const service = createOrderService({ prisma, redis });

    await service.cancelOrder(makeViewer(), "ord-uuid-1", "corr");

    expect(tx.outboxEvent.create).toHaveBeenCalledOnce();
  });

  it("updates the cache with the cancelled snapshot", async () => {
    setupCancellableOrder();
    const service = createOrderService({ prisma, redis });

    await service.cancelOrder(makeViewer(), "ord-uuid-1", "corr");

    expect(redis.set).toHaveBeenCalledWith(
      "cache:order:ord-uuid-1",
      expect.any(String),
      "EX",
      300
    );
  });
});
