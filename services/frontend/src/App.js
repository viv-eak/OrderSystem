import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useMemo, useState, useTransition } from "react";
import { ApiError, apiErrorMessage, cancelOrder, createOrder, createSocketUrl, fetchMe, fetchOrder, fetchOrders, login, logout, refreshSession, signup } from "./api";
import { usePersistentSession, useToasts } from "./hooks";
const emptyItem = () => ({
    sku: "",
    name: "",
    quantity: 1,
    unitPrice: 1
});
const cancellableStatuses = new Set(["CREATED", "ACCEPTED", "PREPARING"]);
function currency(value) {
    return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD"
    }).format(value);
}
function orderMoment(timestamp) {
    return new Intl.DateTimeFormat("en-US", {
        dateStyle: "medium",
        timeStyle: "short"
    }).format(new Date(timestamp));
}
export function App() {
    const [session, setSession] = usePersistentSession();
    const [authUser, setAuthUser] = useState(null);
    const [orders, setOrders] = useState([]);
    const [selectedOrderId, setSelectedOrderId] = useState(null);
    const [selectedOrder, setSelectedOrder] = useState(null);
    const [authMode, setAuthMode] = useState("signup");
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [items, setItems] = useState([emptyItem()]);
    const [submittingAuth, startAuthTransition] = useTransition();
    const [submittingOrder, startOrderTransition] = useTransition();
    const [cancelling, startCancelTransition] = useTransition();
    const [refreshingOrders, startOrdersTransition] = useTransition();
    const [socketState, setSocketState] = useState("offline");
    const [pageError, setPageError] = useState(null);
    const { toasts, pushToast, removeToast } = useToasts();
    const selectedOrderSummary = useMemo(() => orders.find((order) => order.id === selectedOrderId) ?? selectedOrder, [orders, selectedOrder, selectedOrderId]);
    useEffect(() => {
        if (!session) {
            setAuthUser(null);
            setOrders([]);
            setSelectedOrderId(null);
            setSelectedOrder(null);
            setSocketState("offline");
            return;
        }
        let cancelled = false;
        async function bootstrap() {
            try {
                const me = await fetchMe(session.accessToken);
                const orderList = await fetchOrders(session.accessToken);
                if (cancelled) {
                    return;
                }
                setAuthUser(me);
                setOrders(orderList);
                setSelectedOrderId((current) => current ?? orderList[0]?.id ?? null);
                setPageError(null);
            }
            catch (error) {
                if (cancelled) {
                    return;
                }
                if (error instanceof ApiError && error.status === 401) {
                    try {
                        const nextSession = await refreshSession(session.refreshToken);
                        if (cancelled) {
                            return;
                        }
                        setSession(nextSession);
                        pushToast({
                            tone: "info",
                            title: "Session refreshed",
                            message: "Your access token expired and was rotated automatically."
                        });
                        return;
                    }
                    catch (refreshError) {
                        setSession(null);
                        setPageError(apiErrorMessage(refreshError));
                        return;
                    }
                }
                setPageError(apiErrorMessage(error));
            }
        }
        void bootstrap();
        return () => {
            cancelled = true;
        };
    }, [pushToast, session, setSession]);
    useEffect(() => {
        if (!session) {
            return;
        }
        const socket = new WebSocket(createSocketUrl(session.accessToken));
        setSocketState("connecting");
        socket.addEventListener("open", () => setSocketState("live"));
        socket.addEventListener("close", () => setSocketState("offline"));
        socket.addEventListener("error", () => setSocketState("error"));
        socket.addEventListener("message", (event) => {
            const payload = JSON.parse(event.data);
            if (payload.event === "socket.connected") {
                return;
            }
            pushToast({
                tone: "success",
                title: `Order ${payload.data.status}`,
                message: `Order ${payload.data.orderId} changed at ${payload.data.timestamp ?? "just now"}.`
            });
            startOrdersTransition(() => {
                void refreshOrders(session).catch((error) => setPageError(apiErrorMessage(error)));
                if (payload.data.orderId) {
                    void refreshSelectedOrder(session, payload.data.orderId).catch((error) => setPageError(apiErrorMessage(error)));
                }
            });
        });
        return () => {
            socket.close();
        };
    }, [pushToast, session]);
    async function refreshOrders(currentSession) {
        const orderList = await fetchOrders(currentSession.accessToken);
        setOrders(orderList);
    }
    async function refreshSelectedOrder(currentSession, orderId) {
        const order = await fetchOrder(currentSession.accessToken, orderId);
        setSelectedOrder(order);
        setSelectedOrderId(orderId);
    }
    function resetComposer() {
        setItems([emptyItem()]);
    }
    function updateItem(index, patch) {
        setItems((current) => current.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)));
    }
    function addItem() {
        setItems((current) => [...current, emptyItem()]);
    }
    function removeItem(index) {
        setItems((current) => (current.length === 1 ? current : current.filter((_, itemIndex) => itemIndex !== index)));
    }
    function handleAuthSubmit(event) {
        event.preventDefault();
        startAuthTransition(() => {
            void (async () => {
                try {
                    const nextSession = authMode === "signup"
                        ? await signup({ email, password })
                        : await login({ email, password });
                    setSession(nextSession);
                    setEmail("");
                    setPassword("");
                    pushToast({
                        tone: "success",
                        title: authMode === "signup" ? "Account created" : "Signed in",
                        message: `Welcome ${nextSession.user.email}.`
                    });
                }
                catch (error) {
                    setPageError(apiErrorMessage(error));
                }
            })();
        });
    }
    function handleCreateOrder(event) {
        event.preventDefault();
        if (!session) {
            return;
        }
        startOrderTransition(() => {
            void (async () => {
                try {
                    const payload = {
                        items: items.map((item) => ({
                            sku: item.sku.trim(),
                            name: item.name.trim(),
                            quantity: Number(item.quantity),
                            unitPrice: Number(item.unitPrice)
                        }))
                    };
                    const order = await createOrder(session.accessToken, payload);
                    await refreshOrders(session);
                    setSelectedOrder(order);
                    setSelectedOrderId(order.id);
                    resetComposer();
                    pushToast({
                        tone: "success",
                        title: "Order created",
                        message: `Order ${order.id.slice(0, 8)} is now in ${order.status}.`
                    });
                    setPageError(null);
                }
                catch (error) {
                    setPageError(apiErrorMessage(error));
                }
            })();
        });
    }
    function handleLogout() {
        if (!session) {
            return;
        }
        void (async () => {
            try {
                await logout({
                    accessToken: session.accessToken,
                    refreshToken: session.refreshToken
                });
            }
            catch {
                // Local sign-out still proceeds even if the backend logout fails.
            }
            finally {
                setSession(null);
            }
        })();
    }
    function handleSelectOrder(orderId) {
        if (!session) {
            return;
        }
        setSelectedOrderId(orderId);
        void refreshSelectedOrder(session, orderId).catch((error) => {
            setPageError(apiErrorMessage(error));
        });
    }
    function handleCancelOrder(orderId) {
        if (!session) {
            return;
        }
        startCancelTransition(() => {
            void (async () => {
                try {
                    const order = await cancelOrder(session.accessToken, orderId);
                    await refreshOrders(session);
                    setSelectedOrder(order);
                    pushToast({
                        tone: "info",
                        title: "Order cancelled",
                        message: `Order ${order.id.slice(0, 8)} is now ${order.status}.`
                    });
                }
                catch (error) {
                    setPageError(apiErrorMessage(error));
                }
            })();
        });
    }
    const orderTotal = items.reduce((total, item) => total + item.quantity * item.unitPrice, 0);
    return (_jsxs("div", { className: "shell", children: [_jsx("div", { className: "ambient ambient-left" }), _jsx("div", { className: "ambient ambient-right" }), _jsxs("header", { className: "hero", children: [_jsxs("div", { children: [_jsx("p", { className: "eyebrow", children: "Realtime Delivery Control Room" }), _jsx("h1", { children: "Operate orders, auth, and live status updates from one screen." }), _jsxs("p", { className: "lede", children: ["This React frontend talks to the gateway on ", _jsx("code", { children: "localhost:4000" }), ", so you can test the full distributed flow without juggling Postman tabs."] })] }), _jsxs("div", { className: "hero-metrics", children: [_jsxs("article", { className: "metric-card", children: [_jsx("span", { children: "Gateway" }), _jsx("strong", { children: "HTTP + WS" }), _jsx("small", { children: "One public entrypoint for auth, orders, and notifications." })] }), _jsxs("article", { className: "metric-card", children: [_jsx("span", { children: "Socket State" }), _jsx("strong", { children: socketState }), _jsx("small", { children: "Live updates are pushed from Kafka to Redis to the browser." })] })] })] }), pageError ? _jsx("div", { className: "banner error", children: pageError }) : null, _jsxs("main", { className: "dashboard", children: [_jsxs("section", { className: "panel auth-panel", children: [_jsxs("div", { className: "panel-header", children: [_jsxs("div", { children: [_jsx("p", { className: "eyebrow", children: "Identity" }), _jsx("h2", { children: session ? "Signed in" : "Get access" })] }), session ? (_jsx("button", { className: "ghost-button", onClick: handleLogout, type: "button", children: "Logout" })) : null] }), session ? (_jsxs("div", { className: "account-card", children: [_jsx("strong", { children: authUser?.email ?? session.user.email }), _jsx("span", { children: authUser?.role ?? session.user.role }), _jsxs("p", { children: ["User ID: ", (authUser?.id ?? session.user.id).slice(0, 8), "..."] })] })) : (_jsxs(_Fragment, { children: [_jsxs("div", { className: "segmented", children: [_jsx("button", { className: authMode === "signup" ? "active" : "", type: "button", onClick: () => setAuthMode("signup"), children: "Signup" }), _jsx("button", { className: authMode === "login" ? "active" : "", type: "button", onClick: () => setAuthMode("login"), children: "Login" })] }), _jsxs("form", { className: "stack", onSubmit: handleAuthSubmit, children: [_jsxs("label", { children: ["Email", _jsx("input", { required: true, type: "email", value: email, onChange: (event) => setEmail(event.target.value), placeholder: "operator@example.com" })] }), _jsxs("label", { children: ["Password", _jsx("input", { required: true, minLength: 8, type: "password", value: password, onChange: (event) => setPassword(event.target.value), placeholder: "Password123" })] }), _jsx("button", { className: "primary-button", disabled: submittingAuth, type: "submit", children: submittingAuth ? "Working..." : authMode === "signup" ? "Create account" : "Sign in" })] })] }))] }), _jsxs("section", { className: "panel composer-panel", children: [_jsxs("div", { className: "panel-header", children: [_jsxs("div", { children: [_jsx("p", { className: "eyebrow", children: "Order Composer" }), _jsx("h2", { children: "Create realistic orders" })] }), _jsx("span", { className: "pill", children: currency(orderTotal) })] }), _jsxs("form", { className: "stack", onSubmit: handleCreateOrder, children: [items.map((item, index) => (_jsxs("div", { className: "item-grid", children: [_jsx("input", { required: true, placeholder: "SKU", value: item.sku, onChange: (event) => updateItem(index, { sku: event.target.value }) }), _jsx("input", { required: true, placeholder: "Name", value: item.name, onChange: (event) => updateItem(index, { name: event.target.value }) }), _jsx("input", { min: 1, required: true, type: "number", placeholder: "Qty", value: item.quantity, onChange: (event) => updateItem(index, { quantity: Number(event.target.value) }) }), _jsx("input", { min: 0.5, step: 0.5, required: true, type: "number", placeholder: "Unit price", value: item.unitPrice, onChange: (event) => updateItem(index, { unitPrice: Number(event.target.value) }) }), _jsx("button", { className: "ghost-button compact", onClick: () => removeItem(index), type: "button", children: "Remove" })] }, index))), _jsxs("div", { className: "actions", children: [_jsx("button", { className: "ghost-button", onClick: addItem, type: "button", children: "Add item" }), _jsx("button", { className: "primary-button", disabled: !session || submittingOrder, type: "submit", children: submittingOrder ? "Submitting..." : "Create order" })] })] })] }), _jsxs("section", { className: "panel orders-panel", children: [_jsxs("div", { className: "panel-header", children: [_jsxs("div", { children: [_jsx("p", { className: "eyebrow", children: "Orders" }), _jsx("h2", { children: "Latest activity" })] }), _jsx("button", { className: "ghost-button", disabled: !session || refreshingOrders, onClick: () => {
                                            if (!session) {
                                                return;
                                            }
                                            startOrdersTransition(() => {
                                                void refreshOrders(session).catch((error) => setPageError(apiErrorMessage(error)));
                                            });
                                        }, type: "button", children: refreshingOrders ? "Refreshing..." : "Refresh" })] }), _jsx("div", { className: "order-list", children: orders.length ? (orders.map((order) => (_jsxs("button", { className: `order-card ${selectedOrderId === order.id ? "selected" : ""}`, onClick: () => handleSelectOrder(order.id), type: "button", children: [_jsxs("div", { className: "order-card-top", children: [_jsx("strong", { children: order.id.slice(0, 8) }), _jsx("span", { className: `status status-${order.status.toLowerCase()}`, children: order.status })] }), _jsx("p", { children: currency(order.totalAmount) }), _jsx("small", { children: orderMoment(order.updatedAt) })] }, order.id)))) : (_jsx("div", { className: "empty-state", children: "No orders yet. Create one to watch the Kafka-driven lifecycle unfold." })) })] }), _jsxs("section", { className: "panel detail-panel", children: [_jsxs("div", { className: "panel-header", children: [_jsxs("div", { children: [_jsx("p", { className: "eyebrow", children: "Selected Order" }), _jsx("h2", { children: selectedOrderSummary ? `Order ${selectedOrderSummary.id.slice(0, 8)}` : "Choose an order" })] }), selectedOrderSummary && cancellableStatuses.has(selectedOrderSummary.status) ? (_jsx("button", { className: "ghost-button", disabled: cancelling, onClick: () => handleCancelOrder(selectedOrderSummary.id), type: "button", children: cancelling ? "Cancelling..." : "Cancel order" })) : null] }), selectedOrderSummary ? (_jsxs("div", { className: "detail-grid", children: [_jsxs("div", { className: "detail-block", children: [_jsx("span", { children: "Status" }), _jsx("strong", { children: selectedOrderSummary.status })] }), _jsxs("div", { className: "detail-block", children: [_jsx("span", { children: "Total" }), _jsx("strong", { children: currency(selectedOrderSummary.totalAmount) })] }), _jsxs("div", { className: "detail-block", children: [_jsx("span", { children: "Created" }), _jsx("strong", { children: orderMoment(selectedOrderSummary.createdAt) })] }), _jsxs("div", { className: "detail-block", children: [_jsx("span", { children: "Updated" }), _jsx("strong", { children: orderMoment(selectedOrderSummary.updatedAt) })] }), _jsxs("div", { className: "timeline", children: [_jsx("h3", { children: "Items" }), selectedOrderSummary.items.map((item, index) => (_jsxs("div", { className: "timeline-row", children: [_jsx("strong", { children: item.name }), _jsxs("span", { children: [item.quantity, " \u00D7 ", currency(item.unitPrice)] })] }, `${item.sku}-${index}`)))] })] })) : (_jsx("div", { className: "empty-state", children: "Pick an order from the left to inspect it, or create one above to start the full realtime flow." }))] })] }), _jsx("div", { className: "toast-stack", children: toasts.map((toast) => (_jsxs("article", { className: `toast ${toast.tone}`, children: [_jsxs("div", { children: [_jsx("strong", { children: toast.title }), _jsx("p", { children: toast.message })] }), _jsx("button", { onClick: () => removeToast(toast.id), type: "button", children: "Dismiss" })] }, toast.id))) })] }));
}
//# sourceMappingURL=App.js.map