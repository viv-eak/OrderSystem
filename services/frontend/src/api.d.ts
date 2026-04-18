import type { AuthUser, Order, Session } from "./types";
declare class ApiError extends Error {
    status: number;
    body: unknown;
    constructor(message: string, status: number, body: unknown);
}
export declare function apiErrorMessage(error: unknown): string;
export declare function signup(payload: {
    email: string;
    password: string;
}): Promise<Session>;
export declare function login(payload: {
    email: string;
    password: string;
}): Promise<Session>;
export declare function refreshSession(refreshToken: string): Promise<Session>;
export declare function logout(payload: {
    accessToken: string;
    refreshToken?: string;
}): Promise<void>;
export declare function fetchMe(accessToken: string): Promise<AuthUser>;
export declare function fetchOrders(accessToken: string): Promise<Order[]>;
export declare function fetchOrder(accessToken: string, orderId: string): Promise<Order>;
export declare function createOrder(accessToken: string, payload: {
    items: Array<{
        sku: string;
        name: string;
        quantity: number;
        unitPrice: number;
    }>;
}): Promise<Order>;
export declare function cancelOrder(accessToken: string, orderId: string): Promise<Order & {
    cancelled: boolean;
}>;
export declare function createSocketUrl(accessToken: string): string;
export { ApiError };
