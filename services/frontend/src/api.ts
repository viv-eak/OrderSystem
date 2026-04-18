import type { AuthUser, Order, Session } from "./types";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL?.trim() || "";

type JsonRequestOptions = {
  method?: string;
  body?: unknown;
  accessToken?: string;
  signal?: AbortSignal;
};

class ApiError extends Error {
  status: number;
  body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function parseResponseBody(response: Response) {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }

  return response.text();
}

async function requestJson<T>(path: string, options: JsonRequestOptions = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: options.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(options.accessToken
        ? {
            authorization: `Bearer ${options.accessToken}`
          }
        : {})
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    signal: options.signal
  });

  const body = await parseResponseBody(response);
  if (!response.ok) {
    const message =
      typeof body === "object" &&
      body !== null &&
      "message" in body &&
      typeof body.message === "string"
        ? body.message
        : `Request failed with status ${response.status}`;

    throw new ApiError(message, response.status, body);
  }

  return body as T;
}

export function apiErrorMessage(error: unknown) {
  if (error instanceof ApiError) {
    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "Something went wrong";
}

export async function signup(payload: { email: string; password: string }) {
  return requestJson<Session>("/auth/signup", {
    method: "POST",
    body: payload
  });
}

export async function login(payload: { email: string; password: string }) {
  return requestJson<Session>("/auth/login", {
    method: "POST",
    body: payload
  });
}

export async function refreshSession(refreshToken: string) {
  return requestJson<Session>("/auth/refresh", {
    method: "POST",
    body: { refreshToken }
  });
}

export async function logout(payload: { accessToken: string; refreshToken?: string }) {
  return requestJson<void>("/auth/logout", {
    method: "POST",
    accessToken: payload.accessToken,
    body: payload.refreshToken ? { refreshToken: payload.refreshToken } : {}
  });
}

export async function fetchMe(accessToken: string) {
  return requestJson<AuthUser>("/auth/me", {
    accessToken
  });
}

export async function fetchOrders(accessToken: string) {
  return requestJson<Order[]>("/orders/me", {
    accessToken
  });
}

export async function fetchOrder(accessToken: string, orderId: string) {
  return requestJson<Order>(`/orders/${orderId}`, {
    accessToken
  });
}

export async function createOrder(
  accessToken: string,
  payload: { items: Array<{ sku: string; name: string; quantity: number; unitPrice: number }> }
) {
  return requestJson<Order>("/orders", {
    method: "POST",
    accessToken,
    body: payload
  });
}

export async function cancelOrder(accessToken: string, orderId: string) {
  return requestJson<Order & { cancelled: boolean }>(`/orders/${orderId}/cancel`, {
    method: "POST",
    accessToken
  });
}

export function createSocketUrl(accessToken: string) {
  const target = API_BASE_URL || window.location.origin;
  const url = new URL(target);
  url.protocol = url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.searchParams.set("token", accessToken);
  return url.toString();
}

export { ApiError };
