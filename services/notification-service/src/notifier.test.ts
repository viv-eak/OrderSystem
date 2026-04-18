import { describe, expect, it } from "vitest";
import { buildUserEvent } from "./notifier";

// ---------------------------------------------------------------------------
// buildUserEvent
// ---------------------------------------------------------------------------
describe("buildUserEvent", () => {
  it("maps a processing event with currentStatus to a WebSocket payload", () => {
    const result = buildUserEvent({
      eventId: "evt-1",
      eventType: "order.status.updated",
      payload: {
        orderId: "ord-1",
        userId: "user-1",
        currentStatus: "PREPARING",
        updatedAt: "2026-01-01T00:00:00.000Z"
      }
    });

    expect(result).toEqual({
      userId: "user-1",
      event: "order.status.updated",
      data: {
        orderId: "ord-1",
        status: "PREPARING",
        timestamp: "2026-01-01T00:00:00.000Z",
        reason: null
      }
    });
  });

  it("uses failedStage as the status fallback when currentStatus is absent", () => {
    const result = buildUserEvent({
      eventId: "evt-2",
      eventType: "order.failed",
      payload: {
        orderId: "ord-2",
        userId: "user-2",
        failedStage: "ACCEPTING",
        updatedAt: "2026-01-02T00:00:00.000Z"
      }
    });

    expect(result.data.status).toBe("ACCEPTING");
  });

  it('falls back to "UNKNOWN" when neither currentStatus nor failedStage is present', () => {
    const result = buildUserEvent({
      eventId: "evt-3",
      eventType: "order.status.updated",
      payload: {
        orderId: "ord-3",
        userId: "user-3",
        updatedAt: "2026-01-03T00:00:00.000Z"
      }
    });

    expect(result.data.status).toBe("UNKNOWN");
  });

  it("includes the reason field when provided", () => {
    const result = buildUserEvent({
      eventId: "evt-4",
      eventType: "order.failed",
      payload: {
        orderId: "ord-4",
        userId: "user-4",
        currentStatus: "FAILED",
        reason: "Payment declined",
        updatedAt: "2026-01-04T00:00:00.000Z"
      }
    });

    expect(result.data.reason).toBe("Payment declined");
  });

  it("sets reason to null when not supplied", () => {
    const result = buildUserEvent({
      eventId: "evt-5",
      eventType: "order.status.updated",
      payload: {
        orderId: "ord-5",
        userId: "user-5",
        currentStatus: "DELIVERED",
        updatedAt: "2026-01-05T00:00:00.000Z"
      }
    });

    expect(result.data.reason).toBeNull();
  });

  it("always sets event to 'order.status.updated' regardless of eventType", () => {
    const result = buildUserEvent({
      eventId: "evt-6",
      eventType: "order.completed",
      payload: {
        orderId: "ord-6",
        userId: "user-6",
        currentStatus: "DELIVERED",
        updatedAt: "2026-01-06T00:00:00.000Z"
      }
    });

    expect(result.event).toBe("order.status.updated");
  });

  it("forwards the userId directly from the payload", () => {
    const result = buildUserEvent({
      eventId: "evt-7",
      eventType: "order.status.updated",
      payload: {
        orderId: "ord-7",
        userId: "target-user-id",
        currentStatus: "ACCEPTED",
        updatedAt: "2026-01-07T00:00:00.000Z"
      }
    });

    expect(result.userId).toBe("target-user-id");
  });

  it("uses currentStatus over failedStage when both are present", () => {
    const result = buildUserEvent({
      eventId: "evt-8",
      eventType: "order.status.updated",
      payload: {
        orderId: "ord-8",
        userId: "user-8",
        currentStatus: "FAILED",
        failedStage: "PREPARING",
        updatedAt: "2026-01-08T00:00:00.000Z"
      }
    });

    // currentStatus ?? failedStage → currentStatus wins
    expect(result.data.status).toBe("FAILED");
  });
});
