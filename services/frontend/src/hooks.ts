import { useCallback, useEffect, useState } from "react";
import type { Session, Toast } from "./types";

const SESSION_KEY = "ordersystem.session";

export function readStoredSession() {
  const value = window.localStorage.getItem(SESSION_KEY);
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value) as Session;
  } catch {
    window.localStorage.removeItem(SESSION_KEY);
    return null;
  }
}

export function usePersistentSession() {
  const [session, setSession] = useState<Session | null>(() => readStoredSession());

  useEffect(() => {
    if (!session) {
      window.localStorage.removeItem(SESSION_KEY);
      return;
    }

    window.localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  }, [session]);

  return [session, setSession] as const;
}

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    if (!toasts.length) {
      return;
    }

    const timer = window.setTimeout(() => {
      setToasts((current) => current.slice(1));
    }, 4200);

    return () => window.clearTimeout(timer);
  }, [toasts]);

  const pushToast = useCallback((toast: Omit<Toast, "id">) => {
    setToasts((current) => [
      ...current,
      {
        ...toast,
        id: crypto.randomUUID()
      }
    ]);
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  return {
    toasts,
    pushToast,
    removeToast
  };
}
