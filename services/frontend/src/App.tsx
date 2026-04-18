import { FormEvent, useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  ApiError,
  apiErrorMessage,
  cancelOrder,
  createOrder,
  createSocketUrl,
  fetchMe,
  fetchOrder,
  fetchOrders,
  login,
  logout,
  refreshSession,
  signup
} from "./api";
import { usePersistentSession, useToasts } from "./hooks";
import type { AuthUser, Order, OrderItem, Session, UserSocketEvent } from "./types";

const emptyItem = (): OrderItem => ({
  sku: "",
  name: "",
  quantity: 1,
  unitPrice: 1
});

const cancellableStatuses = new Set(["CREATED", "ACCEPTED", "PREPARING"]);

function currency(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD"
  }).format(value);
}

function orderMoment(timestamp: string) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(timestamp));
}

export function App() {
  const [session, setSession] = usePersistentSession();
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [authMode, setAuthMode] = useState<"login" | "signup">("signup");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [items, setItems] = useState<OrderItem[]>([emptyItem()]);
  const [submittingAuth, startAuthTransition] = useTransition();
  const [submittingOrder, startOrderTransition] = useTransition();
  const [cancelling, startCancelTransition] = useTransition();
  const [refreshingOrders, startOrdersTransition] = useTransition();
  const [socketState, setSocketState] = useState("offline");
  const [pageError, setPageError] = useState<string | null>(null);
  const { toasts, pushToast, removeToast } = useToasts();

  const selectedOrderSummary = useMemo(
    () => orders.find((order) => order.id === selectedOrderId) ?? selectedOrder,
    [orders, selectedOrder, selectedOrderId]
  );

  useEffect(() => {
    if (!session) {
      setAuthUser(null);
      setOrders([]);
      setSelectedOrderId(null);
      setSelectedOrder(null);
      setSocketState("offline");
      return;
    }

    const activeSession = session;
    let cancelled = false;

    async function bootstrap() {
      try {
        const me = await fetchMe(activeSession.accessToken);
        const orderList = await fetchOrders(activeSession.accessToken);
        if (cancelled) {
          return;
        }

        setAuthUser(me);
        setOrders(orderList);
        setSelectedOrderId((current) => current ?? orderList[0]?.id ?? null);
        setPageError(null);
      } catch (error) {
        if (cancelled) {
          return;
        }

        if (!(error instanceof ApiError) || error.status !== 401) {
          setPageError(apiErrorMessage(error));
          return;
        }

        let nextSession;
        try {
          nextSession = await refreshSession(activeSession.refreshToken);
        } catch (refreshError) {
          if (!cancelled) {
            setSession(null);
            setPageError(apiErrorMessage(refreshError));
          }
          return;
        }

        if (cancelled) {
          return;
        }

        // Verify the refreshed token works before committing it to state.
        // Calling setSession without this check re-triggers this effect and
        // creates an infinite loop if the backend keeps returning 401.
        try {
          const me = await fetchMe(nextSession.accessToken);
          const orderList = await fetchOrders(nextSession.accessToken);
          if (cancelled) {
            return;
          }

          setSession(nextSession);
          setAuthUser(me);
          setOrders(orderList);
          setSelectedOrderId((current) => current ?? orderList[0]?.id ?? null);
          setPageError(null);
          pushToast({
            tone: "info",
            title: "Session refreshed",
            message: "Your access token expired and was rotated automatically."
          });
        } catch {
          if (!cancelled) {
            setSession(null);
            setPageError("Session could not be restored. Please sign in again.");
          }
        }
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
      const payload = JSON.parse(event.data) as UserSocketEvent;
      if (payload.event === "socket.connected") {
        return;
      }

      pushToast({
        tone: "success",
        title: `Order ${payload.data.status}`,
        message: `Order ${payload.data.orderId} changed at ${payload.data.timestamp ?? "just now"}.`
      });

      startOrdersTransition(() => {
        const currentSession = sessionRef.current;
        if (!currentSession) {
          return;
        }
        void refreshOrders(currentSession).catch((error) => setPageError(apiErrorMessage(error)));
        if (payload.data.orderId) {
          void refreshSelectedOrder(currentSession, payload.data.orderId).catch((error) =>
            setPageError(apiErrorMessage(error))
          );
        }
      });
    });

    return () => {
      socket.close();
    };
  // session.user.id changes on login/logout but not on token refresh, preventing
  // the socket from being torn down and recreated on every access token rotation.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pushToast, session?.user?.id]);

  async function refreshOrders(currentSession: Session) {
    const orderList = await fetchOrders(currentSession.accessToken);
    setOrders(orderList);
  }

  async function refreshSelectedOrder(currentSession: Session, orderId: string) {
    const order = await fetchOrder(currentSession.accessToken, orderId);
    setSelectedOrder(order);
    setSelectedOrderId(orderId);
  }

  function resetComposer() {
    setItems([emptyItem()]);
  }

  function updateItem(index: number, patch: Partial<OrderItem>) {
    setItems((current) =>
      current.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item))
    );
  }

  function addItem() {
    setItems((current) => [...current, emptyItem()]);
  }

  function removeItem(index: number) {
    setItems((current) => (current.length === 1 ? current : current.filter((_, itemIndex) => itemIndex !== index)));
  }

  function handleAuthSubmit(event: FormEvent) {
    event.preventDefault();

    startAuthTransition(() => {
      void (async () => {
        try {
          const nextSession =
            authMode === "signup"
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
        } catch (error) {
          setPageError(apiErrorMessage(error));
        }
      })();
    });
  }

  function handleCreateOrder(event: FormEvent) {
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
        } catch (error) {
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
      } catch {
        // Local sign-out still proceeds even if the backend logout fails.
      } finally {
        setSession(null);
      }
    })();
  }

  function handleSelectOrder(orderId: string) {
    if (!session) {
      return;
    }

    setSelectedOrderId(orderId);
    void refreshSelectedOrder(session, orderId).catch((error) => {
      setPageError(apiErrorMessage(error));
    });
  }

  function handleCancelOrder(orderId: string) {
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
        } catch (error) {
          setPageError(apiErrorMessage(error));
        }
      })();
    });
  }

  const orderTotal = items.reduce((total, item) => total + item.quantity * item.unitPrice, 0);

  return (
    <div className="shell">
      <div className="ambient ambient-left" />
      <div className="ambient ambient-right" />

      <header className="hero">
        <div>
          <p className="eyebrow">Realtime Delivery Control Room</p>
          <h1>Operate orders, auth, and live status updates from one screen.</h1>
          <p className="lede">
            This React frontend talks to the gateway on <code>localhost:4000</code>, so you can test the full
            distributed flow without juggling Postman tabs.
          </p>
        </div>

        <div className="hero-metrics">
          <article className="metric-card">
            <span>Gateway</span>
            <strong>HTTP + WS</strong>
            <small>One public entrypoint for auth, orders, and notifications.</small>
          </article>
          <article className="metric-card">
            <span>Socket State</span>
            <strong>{socketState}</strong>
            <small>Live updates are pushed from Kafka to Redis to the browser.</small>
          </article>
        </div>
      </header>

      {pageError ? <div className="banner error">{pageError}</div> : null}

      <main className="dashboard">
        <section className="panel auth-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Identity</p>
              <h2>{session ? "Signed in" : "Get access"}</h2>
            </div>
            {session ? (
              <button className="ghost-button" onClick={handleLogout} type="button">
                Logout
              </button>
            ) : null}
          </div>

          {session ? (
            <div className="account-card">
              <strong>{authUser?.email ?? session.user.email}</strong>
              <span>{authUser?.role ?? session.user.role}</span>
              <p>User ID: {(authUser?.id ?? session.user.id).slice(0, 8)}...</p>
            </div>
          ) : (
            <>
              <div className="segmented">
                <button
                  className={authMode === "signup" ? "active" : ""}
                  type="button"
                  onClick={() => setAuthMode("signup")}
                >
                  Signup
                </button>
                <button
                  className={authMode === "login" ? "active" : ""}
                  type="button"
                  onClick={() => setAuthMode("login")}
                >
                  Login
                </button>
              </div>

              <form className="stack" onSubmit={handleAuthSubmit}>
                <label>
                  Email
                  <input
                    required
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="operator@example.com"
                  />
                </label>

                <label>
                  Password
                  <input
                    required
                    minLength={8}
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="Password123"
                  />
                </label>

                <button className="primary-button" disabled={submittingAuth} type="submit">
                  {submittingAuth ? "Working..." : authMode === "signup" ? "Create account" : "Sign in"}
                </button>
              </form>
            </>
          )}
        </section>

        <section className="panel composer-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Order Composer</p>
              <h2>Create realistic orders</h2>
            </div>
            <span className="pill">{currency(orderTotal)}</span>
          </div>

          <form className="stack" onSubmit={handleCreateOrder}>
            {items.map((item, index) => (
              <div className="item-grid" key={index}>
                <input
                  required
                  placeholder="SKU"
                  value={item.sku}
                  onChange={(event) => updateItem(index, { sku: event.target.value })}
                />
                <input
                  required
                  placeholder="Name"
                  value={item.name}
                  onChange={(event) => updateItem(index, { name: event.target.value })}
                />
                <input
                  min={1}
                  required
                  type="number"
                  placeholder="Qty"
                  value={item.quantity}
                  onChange={(event) => updateItem(index, { quantity: Number(event.target.value) })}
                />
                <input
                  min={0.5}
                  step={0.5}
                  required
                  type="number"
                  placeholder="Unit price"
                  value={item.unitPrice}
                  onChange={(event) => updateItem(index, { unitPrice: Number(event.target.value) })}
                />
                <button className="ghost-button compact" onClick={() => removeItem(index)} type="button">
                  Remove
                </button>
              </div>
            ))}

            <div className="actions">
              <button className="ghost-button" onClick={addItem} type="button">
                Add item
              </button>
              <button className="primary-button" disabled={!session || submittingOrder} type="submit">
                {submittingOrder ? "Submitting..." : "Create order"}
              </button>
            </div>
          </form>
        </section>

        <section className="panel orders-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Orders</p>
              <h2>Latest activity</h2>
            </div>
            <button
              className="ghost-button"
              disabled={!session || refreshingOrders}
              onClick={() => {
                if (!session) {
                  return;
                }
                startOrdersTransition(() => {
                  void refreshOrders(session).catch((error) => setPageError(apiErrorMessage(error)));
                });
              }}
              type="button"
            >
              {refreshingOrders ? "Refreshing..." : "Refresh"}
            </button>
          </div>

          <div className="order-list">
            {orders.length ? (
              orders.map((order) => (
                <button
                  className={`order-card ${selectedOrderId === order.id ? "selected" : ""}`}
                  key={order.id}
                  onClick={() => handleSelectOrder(order.id)}
                  type="button"
                >
                  <div className="order-card-top">
                    <strong>{order.id.slice(0, 8)}</strong>
                    <span className={`status status-${order.status.toLowerCase()}`}>{order.status}</span>
                  </div>
                  <p>{currency(order.totalAmount)}</p>
                  <small>{orderMoment(order.updatedAt)}</small>
                </button>
              ))
            ) : (
              <div className="empty-state">No orders yet. Create one to watch the Kafka-driven lifecycle unfold.</div>
            )}
          </div>
        </section>

        <section className="panel detail-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Selected Order</p>
              <h2>{selectedOrderSummary ? `Order ${selectedOrderSummary.id.slice(0, 8)}` : "Choose an order"}</h2>
            </div>
            {selectedOrderSummary && cancellableStatuses.has(selectedOrderSummary.status) ? (
              <button
                className="ghost-button"
                disabled={cancelling}
                onClick={() => handleCancelOrder(selectedOrderSummary.id)}
                type="button"
              >
                {cancelling ? "Cancelling..." : "Cancel order"}
              </button>
            ) : null}
          </div>

          {selectedOrderSummary ? (
            <div className="detail-grid">
              <div className="detail-block">
                <span>Status</span>
                <strong>{selectedOrderSummary.status}</strong>
              </div>
              <div className="detail-block">
                <span>Total</span>
                <strong>{currency(selectedOrderSummary.totalAmount)}</strong>
              </div>
              <div className="detail-block">
                <span>Created</span>
                <strong>{orderMoment(selectedOrderSummary.createdAt)}</strong>
              </div>
              <div className="detail-block">
                <span>Updated</span>
                <strong>{orderMoment(selectedOrderSummary.updatedAt)}</strong>
              </div>

              <div className="timeline">
                <h3>Items</h3>
                {selectedOrderSummary.items.map((item, index) => (
                  <div className="timeline-row" key={`${item.sku}-${index}`}>
                    <strong>{item.name}</strong>
                    <span>
                      {item.quantity} × {currency(item.unitPrice)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="empty-state">
              Pick an order from the left to inspect it, or create one above to start the full realtime flow.
            </div>
          )}
        </section>
      </main>

      <div className="toast-stack">
        {toasts.map((toast) => (
          <article className={`toast ${toast.tone}`} key={toast.id}>
            <div>
              <strong>{toast.title}</strong>
              <p>{toast.message}</p>
            </div>
            <button onClick={() => removeToast(toast.id)} type="button">
              Dismiss
            </button>
          </article>
        ))}
      </div>
    </div>
  );
}
