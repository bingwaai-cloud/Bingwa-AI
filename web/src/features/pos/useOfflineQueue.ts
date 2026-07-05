import { useCallback, useEffect, useRef, useState } from "react";
import { openDB, type IDBPDatabase } from "idb";

const DB_NAME = "gezi-pos-queue";
const STORE_NAME = "queued_sales";
const DB_VERSION = 1;

export type CartItem = {
  itemId?: string;
  itemName: string;
  qty: number;
  unit: string;
  unitPrice: number;
  totalPrice: number;
};

export type QueuedSale = {
  id: string;
  items: CartItem[];
  createdAt: string;
  status: "queued" | "draining" | "failed";
  errorReason?: string;
  errorStatus?: number;
};

export type SyncStatus = "synced" | "queued" | "needs_attention";

function getDB(): Promise<IDBPDatabase> {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    }
  });
}

let dbCache: IDBPDatabase | null = null;

async function db(): Promise<IDBPDatabase> {
  if (!dbCache) dbCache = await getDB();
  return dbCache;
}

// Reset DB connection (for tests, after deleteDatabase)
export function resetDB(): void {
  if (dbCache) {
    dbCache.close();
    dbCache = null;
  }
}

export async function clearQueue(): Promise<void> {
  const store = await db();
  await store.clear(STORE_NAME);
}

export function generateIdempotencyKey(): string {
  return crypto.randomUUID();
}

export function useOfflineQueue() {
  const [queuedSales, setQueuedSales] = useState<QueuedSale[]>([]);
  const draining = useRef(false);
  const drainPromise = useRef<Promise<void> | null>(null);

  const loadQueue = useCallback(async () => {
    const store = await db();
    const all = await store.getAll(STORE_NAME);
    setQueuedSales(all);
  }, []);

  useEffect(() => {
    void loadQueue();
  }, [loadQueue]);

  // Poll for queue changes outside this hook's state (e.g. other tabs)
  useEffect(() => {
    const interval = setInterval(() => { void loadQueue(); }, 2000);
    return () => clearInterval(interval);
  }, [loadQueue]);

  const enqueue = useCallback(async (sale: Omit<QueuedSale, "status">): Promise<void> => {
    const record: QueuedSale = { ...sale, status: "queued" };
    const store = await db();
    // put is idempotent — same key overwrites, no constraint error on replay
    await store.put(STORE_NAME, record);
    await loadQueue();
  }, [loadQueue]);

  const updateSale = useCallback(async (id: string, patch: Partial<QueuedSale>): Promise<void> => {
    const store = await db();
    const existing = await store.get(STORE_NAME, id);
    if (!existing) return;
    await store.put(STORE_NAME, { ...existing, ...patch });
    await loadQueue();
  }, [loadQueue]);

  const removeSale = useCallback(async (id: string): Promise<void> => {
    const store = await db();
    await store.delete(STORE_NAME, id);
    await loadQueue();
  }, [loadQueue]);

  const drainQueue = useCallback(async (): Promise<void> => {
    // Single-flight: if already draining, wait for existing drain
    if (draining.current && drainPromise.current) {
      return drainPromise.current;
    }
    draining.current = true;
    drainPromise.current = (async () => {
      try {
        const store = await db();
        const all = await store.getAll(STORE_NAME);
        const pending = all.filter((s) => s.status === "queued");

        for (const sale of pending) {
          // Mark as draining
          await store.put(STORE_NAME, { ...sale, status: "draining" });
          await loadQueue();

          try {
            const resp = await fetch(
              `${import.meta.env.VITE_API_BASE_URL ?? ""}/api/v1/sales`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "Idempotency-Key": sale.id,
                  "x-gezi-source": "pos",
                  Accept: "application/json"
                },
                body: JSON.stringify({
                  items: sale.items,
                  source: "pos"
                }),
                credentials: "include"
              }
            );

            if (resp.ok) {
              await store.delete(STORE_NAME, sale.id);
            } else if (resp.status === 422) {
              await store.put(STORE_NAME, {
                ...sale,
                status: "failed",
                errorReason: "Not enough stock",
                errorStatus: 422
              });
            } else if (resp.status >= 400 && resp.status < 500) {
              await store.put(STORE_NAME, {
                ...sale,
                status: "failed",
                errorReason: `Server error (${resp.status})`,
                errorStatus: resp.status
              });
            } else {
              // 5xx or unknown — leave as draining, will retry on next drain
              await store.put(STORE_NAME, { ...sale, status: "queued" });
            }
          } catch (err: unknown) {
            // Connection refused or network error — leave queued for retry
            const msg = err instanceof TypeError ? err.message : String(err);
            if (msg.includes("fetch") || msg.includes("network") || msg.includes("Failed to fetch")) {
              await store.put(STORE_NAME, { ...sale, status: "queued" });
            } else {
              // Unexpected error — mark failed
              await store.put(STORE_NAME, {
                ...sale,
                status: "failed",
                errorReason: msg.slice(0, 200),
                errorStatus: 0
              });
            }
          }
          await loadQueue();
        }
      } finally {
        draining.current = false;
        drainPromise.current = null;
      }
    })();
    await drainPromise.current;
  }, [loadQueue]);

  // Drain queue on reconnect
  useEffect(() => {
    const handler = () => { void drainQueue(); };
    window.addEventListener("online", handler);
    return () => window.removeEventListener("online", handler);
  }, [drainQueue]);

  // Initial drain if online
  useEffect(() => {
    if (navigator.onLine) void drainQueue();
  }, [drainQueue]);

  const syncStatus: SyncStatus = (() => {
    if (queuedSales.length === 0) return "synced";
    if (queuedSales.some((s) => s.status === "failed")) return "needs_attention";
    return "queued";
  })();

  const queuedCount = queuedSales.filter((s) => s.status === "queued" || s.status === "draining").length;

  return {
    queuedSales,
    syncStatus,
    queuedCount,
    enqueue,
    updateSale,
    removeSale,
    drainQueue
  };
}