import { describe, expect, it, vi, beforeEach } from "vitest";
import { Role } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import type Redis from "ioredis";
import { createAuthService } from "./auth-service";
import { hashPassword, hashToken } from "@ordersystem/shared";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const TEST_ENV = {
  ACCESS_TOKEN_SECRET: "test-access-secret-32-chars-ok!!",
  REFRESH_TOKEN_SECRET: "test-refresh-secret-32-chars-ok!",
  ACCESS_TOKEN_TTL_MINUTES: 15,
  REFRESH_TOKEN_TTL_DAYS: 14
} as const;

function makeUser(overrides: Partial<{ id: string; email: string; role: Role; passwordHash: string }> = {}) {
  return {
    id: "user-uuid-1",
    email: "test@example.com",
    role: Role.USER,
    passwordHash: "hashed-pw",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides
  };
}

function makePrismaMock() {
  return {
    user: {
      findUnique: vi.fn(),
      create: vi.fn()
    },
    refreshToken: {
      create: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn()
    }
  } as unknown as PrismaClient;
}

function makeRedisMock() {
  return {
    set: vi.fn<[], Promise<string | null>>().mockResolvedValue("OK")
  } as unknown as Redis;
}

// ---------------------------------------------------------------------------
// signup
// ---------------------------------------------------------------------------
describe("authService.signup", () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let redis: ReturnType<typeof makeRedisMock>;

  beforeEach(() => {
    prisma = makePrismaMock();
    redis = makeRedisMock();
  });

  it("creates a user and returns a session on first signup", async () => {
    const service = createAuthService({ prisma, redis, env: TEST_ENV as never });
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    const newUser = makeUser();
    vi.mocked(prisma.user.create).mockResolvedValue(newUser);
    vi.mocked(prisma.refreshToken.create).mockResolvedValue({} as never);

    const result = await service.signup({ email: "test@example.com", password: "Password1!" });

    expect(result).not.toBeNull();
    expect(result!.user.email).toBe("test@example.com");
    expect(result!.user.role).toBe(Role.USER);
    expect(result!.accessToken).toBeDefined();
    expect(result!.refreshToken).toBeDefined();
  });

  it("lowercases the email before storing", async () => {
    const service = createAuthService({ prisma, redis, env: TEST_ENV as never });
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.user.create).mockResolvedValue(makeUser({ email: "mixed@example.com" }));
    vi.mocked(prisma.refreshToken.create).mockResolvedValue({} as never);

    await service.signup({ email: "MIXED@EXAMPLE.COM", password: "Password1!" });

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { email: "mixed@example.com" }
    });
    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ email: "mixed@example.com" }) })
    );
  });

  it("returns null when the email is already registered", async () => {
    const service = createAuthService({ prisma, redis, env: TEST_ENV as never });
    vi.mocked(prisma.user.findUnique).mockResolvedValue(makeUser());

    const result = await service.signup({ email: "test@example.com", password: "Password1!" });

    expect(result).toBeNull();
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it("stores the user with role USER", async () => {
    const service = createAuthService({ prisma, redis, env: TEST_ENV as never });
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.user.create).mockResolvedValue(makeUser());
    vi.mocked(prisma.refreshToken.create).mockResolvedValue({} as never);

    await service.signup({ email: "test@example.com", password: "Password1!" });

    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ role: Role.USER }) })
    );
  });
});

// ---------------------------------------------------------------------------
// login
// ---------------------------------------------------------------------------
describe("authService.login", () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let redis: ReturnType<typeof makeRedisMock>;

  beforeEach(() => {
    prisma = makePrismaMock();
    redis = makeRedisMock();
  });

  it("returns a session for valid credentials", async () => {
    const service = createAuthService({ prisma, redis, env: TEST_ENV as never });
    const hash = await hashPassword("Password1!");
    vi.mocked(prisma.user.findUnique).mockResolvedValue(makeUser({ passwordHash: hash }));
    vi.mocked(prisma.refreshToken.create).mockResolvedValue({} as never);

    const result = await service.login({ email: "test@example.com", password: "Password1!" });

    expect(result).not.toBeNull();
    expect(result!.accessToken).toBeDefined();
    expect(result!.refreshToken).toBeDefined();
  });

  it("returns null for an unknown email", async () => {
    const service = createAuthService({ prisma, redis, env: TEST_ENV as never });
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

    expect(await service.login({ email: "nobody@example.com", password: "Password1!" })).toBeNull();
  });

  it("returns null for an incorrect password", async () => {
    const service = createAuthService({ prisma, redis, env: TEST_ENV as never });
    const hash = await hashPassword("CorrectPassword");
    vi.mocked(prisma.user.findUnique).mockResolvedValue(makeUser({ passwordHash: hash }));

    expect(await service.login({ email: "test@example.com", password: "WrongPassword" })).toBeNull();
  });

  it("lowercases the lookup email", async () => {
    const service = createAuthService({ prisma, redis, env: TEST_ENV as never });
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

    await service.login({ email: "Test@EXAMPLE.COM", password: "pw" });

    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { email: "test@example.com" } });
  });

  it("does not create a refresh token for failed login", async () => {
    const service = createAuthService({ prisma, redis, env: TEST_ENV as never });
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

    await service.login({ email: "nobody@example.com", password: "pw" });

    expect(prisma.refreshToken.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// refresh
// ---------------------------------------------------------------------------
describe("authService.refresh", () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let redis: ReturnType<typeof makeRedisMock>;

  beforeEach(() => {
    prisma = makePrismaMock();
    redis = makeRedisMock();
  });

  function makeStoredToken(overrides = {}) {
    return {
      id: "rt-uuid-1",
      userId: "user-uuid-1",
      tokenHash: "will-be-replaced",
      expiresAt: new Date(Date.now() + 86400_000),
      revokedAt: null,
      rotatedFrom: null,
      user: makeUser(),
      ...overrides
    };
  }

  it("returns a new session and revokes the old token for a valid refresh token", async () => {
    const service = createAuthService({ prisma, redis, env: TEST_ENV as never });
    vi.mocked(prisma.refreshToken.findFirst).mockResolvedValue(makeStoredToken() as never);
    vi.mocked(prisma.refreshToken.update).mockResolvedValue({} as never);
    vi.mocked(prisma.refreshToken.create).mockResolvedValue({} as never);

    const result = await service.refresh("valid-opaque-token");

    expect(result).not.toBeNull();
    expect(result!.accessToken).toBeDefined();
    expect(result!.refreshToken).toBeDefined();
    expect(prisma.refreshToken.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ revokedAt: expect.any(Date) }) })
    );
  });

  it("returns null when the token is not found (expired or revoked)", async () => {
    const service = createAuthService({ prisma, redis, env: TEST_ENV as never });
    vi.mocked(prisma.refreshToken.findFirst).mockResolvedValue(null);

    expect(await service.refresh("unknown-token")).toBeNull();
  });

  it("looks up the token by its SHA-256 hash", async () => {
    const service = createAuthService({ prisma, redis, env: TEST_ENV as never });
    vi.mocked(prisma.refreshToken.findFirst).mockResolvedValue(null);

    const rawToken = "raw-refresh-token";
    await service.refresh(rawToken);

    expect(prisma.refreshToken.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tokenHash: hashToken(rawToken) }) })
    );
  });

  it("creates a new refresh token with rotatedFrom pointing to the old one", async () => {
    const service = createAuthService({ prisma, redis, env: TEST_ENV as never });
    const stored = makeStoredToken({ id: "old-rt-id" });
    vi.mocked(prisma.refreshToken.findFirst).mockResolvedValue(stored as never);
    vi.mocked(prisma.refreshToken.update).mockResolvedValue({} as never);
    vi.mocked(prisma.refreshToken.create).mockResolvedValue({} as never);

    await service.refresh("valid-token");

    expect(prisma.refreshToken.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ rotatedFrom: "old-rt-id" }) })
    );
  });
});

// ---------------------------------------------------------------------------
// logout
// ---------------------------------------------------------------------------
describe("authService.logout", () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let redis: ReturnType<typeof makeRedisMock>;

  beforeEach(() => {
    prisma = makePrismaMock();
    redis = makeRedisMock();
    vi.mocked(prisma.refreshToken.updateMany).mockResolvedValue({ count: 1 } as never);
  });

  it("revokes the refresh token when one is supplied", async () => {
    const service = createAuthService({ prisma, redis, env: TEST_ENV as never });
    await service.logout({ refreshToken: "some-refresh-token" });

    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ revokedAt: expect.any(Date) }) })
    );
  });

  it("blacklists the access token JTI in Redis when one is supplied", async () => {
    const service = createAuthService({ prisma, redis, env: TEST_ENV as never });
    const { token } = require("@ordersystem/shared").createAccessToken(
      { sub: "u", email: "e@e.com", role: Role.USER },
      { secret: TEST_ENV.ACCESS_TOKEN_SECRET, expiresInMinutes: 15 }
    );

    await service.logout({ accessToken: token });

    expect(redis.set).toHaveBeenCalledWith(
      expect.stringMatching(/^blacklist:access:/),
      "1",
      "EX",
      expect.any(Number)
    );
  });

  it("does nothing when called with neither token", async () => {
    const service = createAuthService({ prisma, redis, env: TEST_ENV as never });
    await service.logout({});

    expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it("skips Redis blacklist when no access token is provided", async () => {
    const service = createAuthService({ prisma, redis, env: TEST_ENV as never });
    await service.logout({ refreshToken: "some-token" });

    expect(redis.set).not.toHaveBeenCalled();
  });
});
