import crypto from "node:crypto";
import Redis from "ioredis";

export function createRedisClient(url: string) {
  return new Redis(url, {
    maxRetriesPerRequest: 2,
    enableReadyCheck: true
  });
}

export async function isTokenBlacklisted(redis: Redis, jti: string) {
  const result = await redis.get(`blacklist:access:${jti}`);
  return result === "1";
}

export async function blacklistToken(redis: Redis, jti: string, ttlSeconds: number) {
  if (ttlSeconds <= 0) {
    return;
  }

  await redis.set(`blacklist:access:${jti}`, "1", "EX", ttlSeconds);
}

export async function cacheOrderSnapshot(redis: Redis, orderId: string, snapshot: unknown) {
  await redis.set(`cache:order:${orderId}`, JSON.stringify(snapshot), "EX", 300);
}

export async function getCachedOrderSnapshot<T>(redis: Redis, orderId: string): Promise<T | null> {
  const value = await redis.get(`cache:order:${orderId}`);
  return value ? (JSON.parse(value) as T) : null;
}

export async function removeCachedOrderSnapshot(redis: Redis, orderId: string) {
  await redis.del(`cache:order:${orderId}`);
}

export async function takeSlidingWindowToken(
  redis: Redis,
  key: string,
  windowSeconds: number,
  limit: number
) {
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, windowSeconds);
  }

  const ttl = await redis.ttl(key);
  return {
    allowed: count <= limit,
    count,
    retryAfterSeconds: ttl > 0 ? ttl : windowSeconds
  };
}

export async function acquireLock(redis: Redis, key: string, ttlMs: number) {
  const token = crypto.randomUUID();
  const result = await redis.set(key, token, "PX", ttlMs, "NX");
  if (result !== "OK") {
    return null;
  }

  return token;
}

export async function releaseLock(redis: Redis, key: string, token: string) {
  const current = await redis.get(key);
  if (current === token) {
    await redis.del(key);
  }
}

export async function publishSocketEvent(redis: Redis, channel: string, payload: unknown) {
  await redis.publish(channel, JSON.stringify(payload));
}
