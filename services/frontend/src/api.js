const API_BASE_URL = import.meta.env.VITE_API_BASE_URL?.trim() || "";
class ApiError extends Error {
    status;
    body;
    constructor(message, status, body) {
        super(message);
        this.status = status;
        this.body = body;
    }
}
async function parseResponseBody(response) {
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
        return response.json();
    }
    return response.text();
}
async function requestJson(path, options = {}) {
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
        const message = typeof body === "object" &&
            body !== null &&
            "message" in body &&
            typeof body.message === "string"
            ? body.message
            : `Request failed with status ${response.status}`;
        throw new ApiError(message, response.status, body);
    }
    return body;
}
export function apiErrorMessage(error) {
    if (error instanceof ApiError) {
        return error.message;
    }
    if (error instanceof Error) {
        return error.message;
    }
    return "Something went wrong";
}
export async function signup(payload) {
    return requestJson("/auth/signup", {
        method: "POST",
        body: payload
    });
}
export async function login(payload) {
    return requestJson("/auth/login", {
        method: "POST",
        body: payload
    });
}
export async function refreshSession(refreshToken) {
    return requestJson("/auth/refresh", {
        method: "POST",
        body: { refreshToken }
    });
}
export async function logout(payload) {
    return requestJson("/auth/logout", {
        method: "POST",
        accessToken: payload.accessToken,
        body: payload.refreshToken ? { refreshToken: payload.refreshToken } : {}
    });
}
export async function fetchMe(accessToken) {
    return requestJson("/auth/me", {
        accessToken
    });
}
export async function fetchOrders(accessToken) {
    return requestJson("/orders/me", {
        accessToken
    });
}
export async function fetchOrder(accessToken, orderId) {
    return requestJson(`/orders/${orderId}`, {
        accessToken
    });
}
export async function createOrder(accessToken, payload) {
    return requestJson("/orders", {
        method: "POST",
        accessToken,
        body: payload
    });
}
export async function cancelOrder(accessToken, orderId) {
    return requestJson(`/orders/${orderId}/cancel`, {
        method: "POST",
        accessToken
    });
}
export function createSocketUrl(accessToken) {
    const target = API_BASE_URL || window.location.origin;
    const url = new URL(target);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/ws";
    url.searchParams.set("token", accessToken);
    return url.toString();
}
export { ApiError };
//# sourceMappingURL=api.js.map