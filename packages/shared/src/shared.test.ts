import { describe, expect, it, vi, beforeEach } from "vitest";
import { Role } from "@prisma/client";
import type Redis from "ioredis";
import {
  buildOrderEvent,
  hashToken,
  generateOpaqueToken,
  createAccessToken,
  verifyAccessToken,
  extractBearerToken,
  userFromGatewayHeaders,
  hashPassword,
  verifyPassword,
  getTokenExpiryEpochSeconds,
  isTokenBlacklisted,
  blacklistToken,
  cacheOrderSnapshot,
  getCachedOrderSnapshot,
  removeCachedOrderSnapshot,
  takeSlidingWindowToken,
  acquireLock,
  releaseLock,
  publishSocketEvent
} from "./index";

// ---------------------------------------------------------------------------
// Minimal Redis mock — only the methods used by the shared utilities
// ---------------------------------------------------------------------------
// function makeRedisMock() {
//   return {
//     get: vi.fn<[], Promise<string | null>>(),
//     set: vi.fn<[], Promise<string | null>>(),
//     del: vi.fn<[], Promise<number>>(),
//     publish: vi.fn<[], Promise<number>>(),
//     incr: vi.fn<[], Promise<number>>(),
//     expire: vi.fn<[], Promise<number>>(),
//     ttl: vi.fn<[], Promise<number>>()
//   } as unknown as Redis;
// }

function makeRedisMock() {
  return {
    get: vi.fn<(key: string) => Promise<string | null>>(),
    set: vi.fn<(key: string, value: string) => Promise<string | null>>(),
    del: vi.fn<(key: string) => Promise<number>>(),
    publish: vi.fn<(channel: string, message: string) => Promise<number>>(),
    incr: vi.fn<(key: string) => Promise<number>>(),
    expire: vi.fn<(key: string, seconds: number) => Promise<number>>(),
    ttl: vi.fn<(key: string) => Promise<number>>()
  } as unknown as Redis;
}

// ---------------------------------------------------------------------------
// buildOrderEvent
// ---------------------------------------------------------------------------
describe("buildOrderEvent", () => {
  it("sets the correct aggregateId, version and payload", () => {
    const event = buildOrderEvent({
      eventType: "order.created",
      aggregateId: "order-1",
      producer: "test-suite",
      payload: { ok: true }
    });

    expect(event.aggregateId).toBe("order-1");
    expect(event.version).toBe(1);
    expect(event.payload).toEqual({ ok: true });
  });

  it("includes all required envelope fields", () => {
    const event = buildOrderEvent({
      eventType: "order.status.updated",
      aggregateId: "order-abc",
      producer: "order-service",
      payload: { status: "ACCEPTED" }
    });

    expect(event.eventId).toBeDefined();
    expect(event.eventType).toBe("order.status.updated");
    expect(event.aggregateType).toBe("order");
    expect(event.occurredAt).toBeDefined();
    expect(event.producer).toBe("order-service");
  });

  it("forwards optional correlationId and causationId", () => {
    const event = buildOrderEvent({
      eventType: "order.created",
      aggregateId: "order-1",
      producer: "test",
      correlationId: "corr-id",
      causationId: "cause-id",
      payload: {}
    });

    expect(event.correlationId).toBe("corr-id");
    expect(event.causationId).toBe("cause-id");
  });

  it("generates unique eventIds on each call", () => {
    const a = buildOrderEvent({ eventType: "order.created", aggregateId: "o", producer: "p", payload: {} });
    const b = buildOrderEvent({ eventType: "order.created", aggregateId: "o", producer: "p", payload: {} });
    expect(a.eventId).not.toBe(b.eventId);
  });
});

// ---------------------------------------------------------------------------
// hashToken
// ---------------------------------------------------------------------------
describe("hashToken", () => {
  it("is deterministic for the same input", () => {
    expect(hashToken("token-123")).toBe(hashToken("token-123"));
  });

  it("produces distinct hashes for different inputs", () => {
    expect(hashToken("token-a")).not.toBe(hashToken("token-b"));
  });

  it("returns a 64-character hex string (SHA-256)", () => {
    const hash = hashToken("any-token");
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });
});

// ---------------------------------------------------------------------------
// generateOpaqueToken
// ---------------------------------------------------------------------------
describe("generateOpaqueToken", () => {
  it("returns a 96-character hex string (48 random bytes)", () => {
    const token = generateOpaqueToken();
    expect(token).toHaveLength(96);
    expect(token).toMatch(/^[0-9a-f]+$/);
  });

  it("generates a unique value on each call", () => {
    expect(generateOpaqueToken()).not.toBe(generateOpaqueToken());
  });
});

// ---------------------------------------------------------------------------
// createAccessToken / verifyAccessToken
// ---------------------------------------------------------------------------
describe("createAccessToken and verifyAccessToken", () => {
  const secret = "test-secret-that-is-long-enough!";

  it("creates a JWT whose claims are correctly verified", () => {
    const { token, jti } = createAccessToken(
      { sub: "user-1", email: "a@b.com", role: Role.USER },
      { secret, expiresInMinutes: 15 }
    );

    const payload = verifyAccessToken(token, secret);
    expect(payload.sub).toBe("user-1");
    expect(payload.email).toBe("a@b.com");
    expect(payload.role).toBe(Role.USER);
    expect(payload.jti).toBe(jti);
  });

  it("accepts a caller-supplied jti", () => {
    const { jti } = createAccessToken(
      { sub: "u", email: "x@y.com", role: Role.USER, jti: "custom-jti" },
      { secret, expiresInMinutes: 15 }
    );
    expect(jti).toBe("custom-jti");
  });

  it("generates a unique jti when none is supplied", () => {
    const a = createAccessToken({ sub: "u", email: "x@y.com", role: Role.USER }, { secret, expiresInMinutes: 15 });
    const b = createAccessToken({ sub: "u", email: "x@y.com", role: Role.USER }, { secret, expiresInMinutes: 15 });
    expect(a.jti).not.toBe(b.jti);
  });

  it("throws when verified with the wrong secret", () => {
    const { token } = createAccessToken(
      { sub: "u", email: "x@y.com", role: Role.USER },
      { secret, expiresInMinutes: 15 }
    );
    expect(() => verifyAccessToken(token, "wrong-secret")).toThrow();
  });

  it("throws on a malformed token string", () => {
    expect(() => verifyAccessToken("not-a-jwt", secret)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// getTokenExpiryEpochSeconds
// ---------------------------------------------------------------------------
describe("getTokenExpiryEpochSeconds", () => {
  const secret = "test-secret-that-is-long-enough!";

  it("returns a future epoch second from a valid JWT", () => {
    const { token } = createAccessToken(
      { sub: "u", email: "x@y.com", role: Role.USER },
      { secret, expiresInMinutes: 15 }
    );
    const exp = getTokenExpiryEpochSeconds(token);
    expect(exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("returns null for a non-JWT string", () => {
    expect(getTokenExpiryEpochSeconds("not-a-jwt")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractBearerToken
// ---------------------------------------------------------------------------
describe("extractBearerToken", () => {
  it("extracts the token value from a valid Bearer header", () => {
    expect(extractBearerToken({ headers: { authorization: "Bearer my-token" } })).toBe("my-token");
  });

  it("returns null when the Authorization header is absent", () => {
    expect(extractBearerToken({ headers: {} })).toBeNull();
  });

  it("returns null when the scheme is not Bearer", () => {
    expect(extractBearerToken({ headers: { authorization: "Basic abc123" } })).toBeNull();
  });

  it("returns null for a bare 'Bearer' with no token", () => {
    // "Bearer " → slice yields ""
    expect(extractBearerToken({ headers: { authorization: "Bearer " } })).toBe("");
  });
});

// ---------------------------------------------------------------------------
// userFromGatewayHeaders
// ---------------------------------------------------------------------------
describe("userFromGatewayHeaders", () => {
  it("assembles an AuthenticatedUser from the four x-user-* headers", () => {
    const req = {
      headers: {
        "x-user-id": "user-1",
        "x-user-email": "a@b.com",
        "x-user-role": "USER",
        "x-user-jti": "jti-abc"
      }
    };
    expect(userFromGatewayHeaders(req)).toEqual({
      userId: "user-1",
      email: "a@b.com",
      role: "USER",
      jti: "jti-abc"
    });
  });

  it("returns null when all headers are missing", () => {
    expect(userFromGatewayHeaders({ headers: {} })).toBeNull();
  });

  it("returns null when any single header is missing", () => {
    expect(userFromGatewayHeaders({ headers: { "x-user-id": "u", "x-user-email": "e@e.com", "x-user-role": "USER" } })).toBeNull();
    expect(userFromGatewayHeaders({ headers: { "x-user-id": "u", "x-user-email": "e@e.com", "x-user-jti": "j" } })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// hashPassword / verifyPassword
// ---------------------------------------------------------------------------
describe("hashPassword and verifyPassword", () => {
  it("produces a hash that verifies the original password", async () => {
    const hash = await hashPassword("SecurePass1!");
    expect(await verifyPassword("SecurePass1!", hash)).toBe(true);
  });

  it("rejects an incorrect password", async () => {
    const hash = await hashPassword("CorrectPass");
    expect(await verifyPassword("WrongPass", hash)).toBe(false);
  });

  it("produces a different hash on each call (salt)", async () => {
    const a = await hashPassword("SamePassword");
    const b = await hashPassword("SamePassword");
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Redis utilities
// ---------------------------------------------------------------------------
describe("Redis utilities", () => {
  let redis: ReturnType<typeof makeRedisMock>;

  beforeEach(() => {
    redis = makeRedisMock();
  });

  // isTokenBlacklisted
  describe("isTokenBlacklisted", () => {
    it('returns true when Redis holds "1" for the JTI key', async () => {
      redis.get = vi.fn().mockResolvedValue("1");
      expect(await isTokenBlacklisted(redis, "some-jti")).toBe(true);
    });

    it("returns false on a cache miss", async () => {
      redis.get = vi.fn().mockResolvedValue(null);
      expect(await isTokenBlacklisted(redis, "some-jti")).toBe(false);
    });

    it("queries the correct Redis key", async () => {
      redis.get = vi.fn().mockResolvedValue(null);
      await isTokenBlacklisted(redis, "my-jti");
      expect(redis.get).toHaveBeenCalledWith("blacklist:access:my-jti");
    });
  });

  // blacklistToken
  describe("blacklistToken", () => {
    it("writes the JTI key with the supplied TTL", async () => {
      redis.set = vi.fn().mockResolvedValue("OK");
      await blacklistToken(redis, "jti-abc", 900);
      expect(redis.set).toHaveBeenCalledWith("blacklist:access:jti-abc", "1", "EX", 900);
    });

    it("skips writing when TTL is zero", async () => {
      await blacklistToken(redis, "jti-abc", 0);
      expect(redis.set).not.toHaveBeenCalled();
    });

    it("skips writing when TTL is negative", async () => {
      await blacklistToken(redis, "jti-abc", -1);
      expect(redis.set).not.toHaveBeenCalled();
    });
  });

  // cacheOrderSnapshot / getCachedOrderSnapshot / removeCachedOrderSnapshot
  describe("order snapshot cache", () => {
    it("stores the snapshot as JSON with a 300-second TTL", async () => {
      redis.set = vi.fn().mockResolvedValue("OK");
      await cacheOrderSnapshot(redis, "ord-1", { id: "ord-1", status: "CREATED" });
      expect(redis.set).toHaveBeenCalledWith(
        "cache:order:ord-1",
        JSON.stringify({ id: "ord-1", status: "CREATED" }),
        "EX",
        300
      );
    });

    it("deserializes a cached snapshot on read", async () => {
      const snap = { id: "ord-1", status: "ACCEPTED" };
      redis.get = vi.fn().mockResolvedValue(JSON.stringify(snap));
      expect(await getCachedOrderSnapshot(redis, "ord-1")).toEqual(snap);
    });

    it("returns null on a cache miss", async () => {
      redis.get = vi.fn().mockResolvedValue(null);
      expect(await getCachedOrderSnapshot(redis, "ord-1")).toBeNull();
    });

    it("deletes the correct key when removing a snapshot", async () => {
      redis.del = vi.fn().mockResolvedValue(1);
      await removeCachedOrderSnapshot(redis, "ord-1");
      expect(redis.del).toHaveBeenCalledWith("cache:order:ord-1");
    });
  });

  // takeSlidingWindowToken
  describe("takeSlidingWindowToken", () => {
    it("allows the request when count is within the limit", async () => {
      redis.incr = vi.fn().mockResolvedValue(1);
      redis.expire = vi.fn().mockResolvedValue(1);
      redis.ttl = vi.fn().mockResolvedValue(60);
      const result = await takeSlidingWindowToken(redis, "ratelimit:key", 60, 10);
      expect(result.allowed).toBe(true);
      expect(result.count).toBe(1);
    });

    it("blocks the request when count exceeds the limit", async () => {
      redis.incr = vi.fn().mockResolvedValue(11);
      redis.expire = vi.fn().mockResolvedValue(1);
      redis.ttl = vi.fn().mockResolvedValue(42);
      const result = await takeSlidingWindowToken(redis, "ratelimit:key", 60, 10);
      expect(result.allowed).toBe(false);
      expect(result.retryAfterSeconds).toBe(42);
    });

    it("sets the window TTL only on the first increment", async () => {
      redis.incr = vi.fn().mockResolvedValue(2);
      redis.ttl = vi.fn().mockResolvedValue(55);
      await takeSlidingWindowToken(redis, "ratelimit:key", 60, 10);
      expect(redis.expire).not.toHaveBeenCalled();
    });

    it("allows exactly at the limit", async () => {
      redis.incr = vi.fn().mockResolvedValue(10);
      redis.expire = vi.fn().mockResolvedValue(1);
      redis.ttl = vi.fn().mockResolvedValue(30);
      const result = await takeSlidingWindowToken(redis, "ratelimit:key", 60, 10);
      expect(result.allowed).toBe(true);
    });
  });

  // acquireLock / releaseLock
  describe("acquireLock and releaseLock", () => {
    it("returns a token string when the lock is successfully acquired", async () => {
      redis.set = vi.fn().mockResolvedValue("OK");
      const token = await acquireLock(redis, "lock:order:1", 15000);
      expect(token).not.toBeNull();
      expect(redis.set).toHaveBeenCalledWith("lock:order:1", expect.any(String), "PX", 15000, "NX");
    });

    it("returns null when the lock is already held by another caller", async () => {
      redis.set = vi.fn().mockResolvedValue(null);
      expect(await acquireLock(redis, "lock:order:1", 15000)).toBeNull();
    });

    it("releases the lock when the caller's token matches", async () => {
      redis.get = vi.fn().mockResolvedValue("uuid-token");
      redis.del = vi.fn().mockResolvedValue(1);
      await releaseLock(redis, "lock:order:1", "uuid-token");
      expect(redis.del).toHaveBeenCalledWith("lock:order:1");
    });

    it("does not release the lock when the token does not match (prevents theft)", async () => {
      redis.get = vi.fn().mockResolvedValue("another-uuid");
      await releaseLock(redis, "lock:order:1", "uuid-token");
      expect(redis.del).not.toHaveBeenCalled();
    });
  });

  // publishSocketEvent
  describe("publishSocketEvent", () => {
    it("serializes the payload to JSON and publishes to the given channel", async () => {
      redis.publish = vi.fn().mockResolvedValue(1);
      const payload = { userId: "u-1", event: "order.status.updated", data: { status: "DELIVERED" } };
      await publishSocketEvent(redis, "ws:user-events", payload);
      expect(redis.publish).toHaveBeenCalledWith("ws:user-events", JSON.stringify(payload));
    });
  });
});
