import { describe, expect, it } from "vitest";
import { OrderStatus } from "@prisma/client";
import { isTerminalStatus, nextLifecycleStatuses } from "./lifecycle";

// ---------------------------------------------------------------------------
// nextLifecycleStatuses
// ---------------------------------------------------------------------------
describe("nextLifecycleStatuses", () => {
  it("returns all four remaining stages from CREATED", () => {
    expect(nextLifecycleStatuses(OrderStatus.CREATED)).toEqual([
      OrderStatus.ACCEPTED,
      OrderStatus.PREPARING,
      OrderStatus.OUT_FOR_DELIVERY,
      OrderStatus.DELIVERED
    ]);
  });

  it("returns three stages from ACCEPTED", () => {
    expect(nextLifecycleStatuses(OrderStatus.ACCEPTED)).toEqual([
      OrderStatus.PREPARING,
      OrderStatus.OUT_FOR_DELIVERY,
      OrderStatus.DELIVERED
    ]);
  });

  it("returns two stages from PREPARING", () => {
    expect(nextLifecycleStatuses(OrderStatus.PREPARING)).toEqual([
      OrderStatus.OUT_FOR_DELIVERY,
      OrderStatus.DELIVERED
    ]);
  });

  it("returns only DELIVERED from OUT_FOR_DELIVERY", () => {
    expect(nextLifecycleStatuses(OrderStatus.OUT_FOR_DELIVERY)).toEqual([
      OrderStatus.DELIVERED
    ]);
  });

  it("returns an empty array for terminal status DELIVERED", () => {
    expect(nextLifecycleStatuses(OrderStatus.DELIVERED)).toEqual([]);
  });

  it("returns an empty array for terminal status CANCELLED", () => {
    expect(nextLifecycleStatuses(OrderStatus.CANCELLED)).toEqual([]);
  });

  it("returns an empty array for terminal status FAILED", () => {
    expect(nextLifecycleStatuses(OrderStatus.FAILED)).toEqual([]);
  });

  it("each path ends with DELIVERED as the final stage", () => {
    const nonTerminalStarts = [
      OrderStatus.CREATED,
      OrderStatus.ACCEPTED,
      OrderStatus.PREPARING,
      OrderStatus.OUT_FOR_DELIVERY
    ];

    for (const status of nonTerminalStarts) {
      const stages = nextLifecycleStatuses(status);
      expect(stages.at(-1)).toBe(OrderStatus.DELIVERED);
    }
  });

  it("each path is a strict sub-sequence of the full lifecycle", () => {
    const fullPath = [
      OrderStatus.ACCEPTED,
      OrderStatus.PREPARING,
      OrderStatus.OUT_FOR_DELIVERY,
      OrderStatus.DELIVERED
    ];

    expect(nextLifecycleStatuses(OrderStatus.CREATED)).toEqual(fullPath);
    expect(nextLifecycleStatuses(OrderStatus.ACCEPTED)).toEqual(fullPath.slice(1));
    expect(nextLifecycleStatuses(OrderStatus.PREPARING)).toEqual(fullPath.slice(2));
    expect(nextLifecycleStatuses(OrderStatus.OUT_FOR_DELIVERY)).toEqual(fullPath.slice(3));
  });
});

// ---------------------------------------------------------------------------
// isTerminalStatus
// ---------------------------------------------------------------------------
describe("isTerminalStatus", () => {
  it("returns true for DELIVERED", () => {
    expect(isTerminalStatus(OrderStatus.DELIVERED)).toBe(true);
  });

  it("returns true for CANCELLED", () => {
    expect(isTerminalStatus(OrderStatus.CANCELLED)).toBe(true);
  });

  it("returns true for FAILED", () => {
    expect(isTerminalStatus(OrderStatus.FAILED)).toBe(true);
  });

  it("returns false for CREATED (active state)", () => {
    expect(isTerminalStatus(OrderStatus.CREATED)).toBe(false);
  });

  it("returns false for ACCEPTED (active state)", () => {
    expect(isTerminalStatus(OrderStatus.ACCEPTED)).toBe(false);
  });

  it("returns false for PREPARING (active state)", () => {
    expect(isTerminalStatus(OrderStatus.PREPARING)).toBe(false);
  });

  it("returns false for OUT_FOR_DELIVERY (active state)", () => {
    expect(isTerminalStatus(OrderStatus.OUT_FOR_DELIVERY)).toBe(false);
  });

  it("active statuses produce non-empty nextLifecycleStatuses lists", () => {
    const activeStatuses = [
      OrderStatus.CREATED,
      OrderStatus.ACCEPTED,
      OrderStatus.PREPARING,
      OrderStatus.OUT_FOR_DELIVERY
    ];

    for (const status of activeStatuses) {
      expect(isTerminalStatus(status)).toBe(false);
      expect(nextLifecycleStatuses(status).length).toBeGreaterThan(0);
    }
  });

  it("terminal statuses produce empty nextLifecycleStatuses lists", () => {
    const terminalStatuses = [OrderStatus.DELIVERED, OrderStatus.CANCELLED, OrderStatus.FAILED];

    for (const status of terminalStatuses) {
      expect(isTerminalStatus(status)).toBe(true);
      expect(nextLifecycleStatuses(status)).toHaveLength(0);
    }
  });
});
