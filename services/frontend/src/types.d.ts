export type UserRole = "USER" | "ADMIN";
export type Session = {
    accessToken: string;
    refreshToken: string;
    user: {
        id: string;
        email: string;
        role: UserRole;
    };
};
export type AuthUser = {
    id: string;
    email: string;
    role: UserRole;
    createdAt: string;
};
export type OrderStatus = "CREATED" | "ACCEPTED" | "PREPARING" | "OUT_FOR_DELIVERY" | "DELIVERED" | "CANCELLED" | "FAILED";
export type OrderItem = {
    id?: string;
    sku: string;
    name: string;
    quantity: number;
    unitPrice: number;
};
export type Order = {
    id: string;
    userId: string;
    status: OrderStatus;
    totalAmount: number;
    cancelledAt: string | null;
    createdAt: string;
    updatedAt: string;
    items: OrderItem[];
};
export type UserSocketEvent = {
    event: "order.status.updated" | "socket.connected";
    data: {
        orderId?: string;
        status?: OrderStatus | string;
        timestamp?: string;
        reason?: string | null;
        userId?: string;
    };
};
export type Toast = {
    id: string;
    tone: "info" | "success" | "error";
    title: string;
    message: string;
};
