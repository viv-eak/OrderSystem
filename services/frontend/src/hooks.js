import { useEffect, useState } from "react";
const SESSION_KEY = "ordersystem.session";
export function readStoredSession() {
    const value = window.localStorage.getItem(SESSION_KEY);
    if (!value) {
        return null;
    }
    try {
        return JSON.parse(value);
    }
    catch {
        window.localStorage.removeItem(SESSION_KEY);
        return null;
    }
}
export function usePersistentSession() {
    const [session, setSession] = useState(() => readStoredSession());
    useEffect(() => {
        if (!session) {
            window.localStorage.removeItem(SESSION_KEY);
            return;
        }
        window.localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    }, [session]);
    return [session, setSession];
}
export function useToasts() {
    const [toasts, setToasts] = useState([]);
    useEffect(() => {
        if (!toasts.length) {
            return;
        }
        const timer = window.setTimeout(() => {
            setToasts((current) => current.slice(1));
        }, 4200);
        return () => window.clearTimeout(timer);
    }, [toasts]);
    function pushToast(toast) {
        setToasts((current) => [
            ...current,
            {
                ...toast,
                id: crypto.randomUUID()
            }
        ]);
    }
    function removeToast(id) {
        setToasts((current) => current.filter((toast) => toast.id !== id));
    }
    return {
        toasts,
        pushToast,
        removeToast
    };
}
//# sourceMappingURL=hooks.js.map