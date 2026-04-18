import type { Session, Toast } from "./types";
export declare function readStoredSession(): Session | null;
export declare function usePersistentSession(): readonly [Session | null, import("react").Dispatch<import("react").SetStateAction<Session | null>>];
export declare function useToasts(): {
    toasts: Toast[];
    pushToast: (toast: Omit<Toast, "id">) => void;
    removeToast: (id: string) => void;
};
