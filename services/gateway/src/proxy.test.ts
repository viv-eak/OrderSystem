import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { Request, Response } from "express";
import { proxyJsonRequest } from "./proxy";

// ---------------------------------------------------------------------------
// Helpers to build minimal Express req/res fakes
// ---------------------------------------------------------------------------
function makeReq(overrides: Partial<{
  method: string;
  originalUrl: string;
  headers: Record<string, string>;
  body: unknown;
}> = {}): Request {
  return {
    method: "GET",
    originalUrl: "/orders/me",
    headers: {},
    body: undefined,
    ...overrides
  } as unknown as Request;
}

function makeRes(): Response & {
  _status: number;
  _body: unknown;
  _headers: Record<string, string>;
} {
  const res = {
    _status: 200,
    _body: undefined as unknown,
    _headers: {} as Record<string, string>,
    status(code: number) {
      this._status = code;
      return this;
    },
    send(body: unknown) {
      this._body = body;
      return this;
    },
    setHeader(name: string, value: string) {
      this._headers[name.toLowerCase()] = value;
    }
  };
  return res as unknown as Response & { _status: number; _body: unknown; _headers: Record<string, string> };
}

function makeUpstreamResponse(status: number, body: string, contentType = "application/json") {
  return {
    status,
    headers: {
      get: (name: string) => (name === "content-type" ? contentType : null)
    },
    text: vi.fn().mockResolvedValue(body)
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("proxyJsonRequest", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("constructs the target URL from baseUrl and originalUrl", async () => {
    const upstream = makeUpstreamResponse(200, '{"ok":true}');
    vi.mocked(fetch).mockResolvedValue(upstream as unknown as Response);

    const req = makeReq({ originalUrl: "/orders/me" });
    const res = makeRes();

    await proxyJsonRequest(req, res, "http://order-service:4002");

    const calledUrl = (vi.mocked(fetch).mock.calls[0] as [URL | string])[0] as URL;
    expect(calledUrl.pathname).toBe("/orders/me");
    expect(calledUrl.hostname).toBe("order-service");
    expect(calledUrl.port).toBe("4002");
  });

  it("preserves query parameters from the original URL", async () => {
    vi.mocked(fetch).mockResolvedValue(makeUpstreamResponse(200, "[]") as unknown as Response);

    const req = makeReq({ originalUrl: "/orders?page=2&limit=10" });
    const res = makeRes();

    await proxyJsonRequest(req, res, "http://order-service:4002");

    const calledUrl = (vi.mocked(fetch).mock.calls[0] as [URL | string])[0] as URL;
    expect(calledUrl.searchParams.get("page")).toBe("2");
    expect(calledUrl.searchParams.get("limit")).toBe("10");
  });

  it("forwards the Authorization header from the original request", async () => {
    vi.mocked(fetch).mockResolvedValue(makeUpstreamResponse(200, "{}") as unknown as Response);

    const req = makeReq({ headers: { authorization: "Bearer token-abc" } });
    const res = makeRes();

    await proxyJsonRequest(req, res, "http://auth-service:4001");

    const [, options] = vi.mocked(fetch).mock.calls[0] as [URL, RequestInit];
    expect((options.headers as Record<string, string>).authorization).toBe("Bearer token-abc");
  });

  it("forwards the x-correlation-id header", async () => {
    vi.mocked(fetch).mockResolvedValue(makeUpstreamResponse(200, "{}") as unknown as Response);

    const req = makeReq({ headers: { "x-correlation-id": "corr-uuid-1" } });
    const res = makeRes();

    await proxyJsonRequest(req, res, "http://auth-service:4001");

    const [, options] = vi.mocked(fetch).mock.calls[0] as [URL, RequestInit];
    expect((options.headers as Record<string, string>)["x-correlation-id"]).toBe("corr-uuid-1");
  });

  it("injects extra headers (e.g. x-user-id) into the upstream call", async () => {
    vi.mocked(fetch).mockResolvedValue(makeUpstreamResponse(200, "{}") as unknown as Response);

    const req = makeReq({ headers: { authorization: "Bearer tok" } });
    const res = makeRes();

    await proxyJsonRequest(req, res, "http://order-service:4002", {
      "x-user-id": "user-uuid-1",
      "x-user-role": "USER"
    });

    const [, options] = vi.mocked(fetch).mock.calls[0] as [URL, RequestInit];
    expect((options.headers as Record<string, string>)["x-user-id"]).toBe("user-uuid-1");
    expect((options.headers as Record<string, string>)["x-user-role"]).toBe("USER");
  });

  it("sends no body for GET requests", async () => {
    vi.mocked(fetch).mockResolvedValue(makeUpstreamResponse(200, "{}") as unknown as Response);

    const req = makeReq({ method: "GET", originalUrl: "/orders/me" });
    const res = makeRes();

    await proxyJsonRequest(req, res, "http://order-service:4002");

    const [, options] = vi.mocked(fetch).mock.calls[0] as [URL, RequestInit];
    expect(options.body).toBeUndefined();
  });

  it("sends a JSON-serialised body for POST requests", async () => {
    vi.mocked(fetch).mockResolvedValue(makeUpstreamResponse(201, '{"id":"ord-1"}') as unknown as Response);

    const req = makeReq({
      method: "POST",
      originalUrl: "/orders",
      body: { items: [{ sku: "A", name: "B", quantity: 1, unitPrice: 5 }] }
    });
    const res = makeRes();

    await proxyJsonRequest(req, res, "http://order-service:4002");

    const [, options] = vi.mocked(fetch).mock.calls[0] as [URL, RequestInit];
    expect(options.body).toBe(JSON.stringify(req.body));
    expect(options.method).toBe("POST");
  });

  it("mirrors the upstream HTTP status code", async () => {
    vi.mocked(fetch).mockResolvedValue(makeUpstreamResponse(404, '{"message":"not found"}') as unknown as Response);

    const req = makeReq({ originalUrl: "/orders/bad-id" });
    const res = makeRes();

    await proxyJsonRequest(req, res, "http://order-service:4002");

    expect(res._status).toBe(404);
  });

  it("forwards the upstream content-type response header", async () => {
    vi.mocked(fetch).mockResolvedValue(
      makeUpstreamResponse(200, '{"ok":true}', "application/json; charset=utf-8") as unknown as Response
    );

    const req = makeReq();
    const res = makeRes();

    await proxyJsonRequest(req, res, "http://order-service:4002");

    expect(res._headers["content-type"]).toContain("application/json");
  });

  it("sends the upstream body text verbatim", async () => {
    const body = '{"id":"ord-abc","status":"CREATED"}';
    vi.mocked(fetch).mockResolvedValue(makeUpstreamResponse(200, body) as unknown as Response);

    const req = makeReq();
    const res = makeRes();

    await proxyJsonRequest(req, res, "http://order-service:4002");

    expect(res._body).toBe(body);
  });

  it("uses HEAD method without sending a body", async () => {
    vi.mocked(fetch).mockResolvedValue(makeUpstreamResponse(200, "") as unknown as Response);

    const req = makeReq({ method: "HEAD", originalUrl: "/health" });
    const res = makeRes();

    await proxyJsonRequest(req, res, "http://gateway:4000");

    const [, options] = vi.mocked(fetch).mock.calls[0] as [URL, RequestInit];
    expect(options.method).toBe("HEAD");
    expect(options.body).toBeUndefined();
  });
});
