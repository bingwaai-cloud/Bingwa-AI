import type React from "react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { listInventory, type InventoryItem } from "@/lib/api";
import { useOfflineQueue, generateIdempotencyKey, type CartItem, type QueuedSale } from "./useOfflineQueue";
import { ItemGrid } from "./ItemGrid";
import { Cart } from "./Cart";
import { SyncPill } from "./SyncPill";

/**
 * POS screen — full-screen, no nav chrome.
 * Offline-first: sales queue locally (IndexedDB), sync on reconnect.
 *
 * NOTE: Server-side idempotency for sales does not exist yet.
 * The client drains single-flight and only retries on connection-refused
 * (fetch TypeError), never on ambiguous/timeout responses.
 * POS writes are NOT production-ready until server idempotency lands.
 */
export function PosPage(): React.ReactElement {
  const { t } = useTranslation();
  const { queuedSales, syncStatus, queuedCount, enqueue, removeSale, drainQueue } = useOfflineQueue();
  const [cartItems, setCartItems] = useState<CartItem[]>([]);

  // Fetch all inventory (large perPage for client-side ranking)
  const { data: inventoryResp, isLoading } = useQuery({
    queryKey: ["inventory", "pos"],
    queryFn: () => listInventory({ perPage: 500 }),
    staleTime: 30_000
  });

  const inventory: InventoryItem[] = inventoryResp?.data ?? [];

  const handleAddToCart = useCallback((item: CartItem) => {
    setCartItems((prev) => [...prev, item]);
  }, []);

  const handleUpdateQty = useCallback((index: number, delta: number) => {
    setCartItems((prev) => {
      const next = [...prev];
      const current = next[index];
      if (!current) return prev;
      const newQty = Math.max(1, current.qty + delta);
      next[index] = { ...current, qty: newQty, totalPrice: newQty * current.unitPrice };
      return next;
    });
  }, []);

  const handleUpdatePrice = useCallback((index: number, price: number) => {
    setCartItems((prev) => {
      const next = [...prev];
      const current = next[index];
      if (!current || price <= 0) return prev;
      next[index] = { ...current, unitPrice: price, totalPrice: current.qty * price };
      return next;
    });
  }, []);

  const handleRemove = useCallback((index: number) => {
    setCartItems((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleCharge = useCallback(() => {
    if (cartItems.length === 0) return;
    const id = generateIdempotencyKey();
    void enqueue({
      id,
      items: cartItems.map(({ itemId, itemName, qty, unit, unitPrice, totalPrice }) => ({
        itemId,
        itemName,
        qty,
        unit,
        unitPrice,
        totalPrice
      })),
      createdAt: new Date().toISOString()
    });
    setCartItems([]);
    // Drain immediately if online
    if (navigator.onLine) void drainQueue();
  }, [cartItems, enqueue, drainQueue]);

  const handleRetryFailed = useCallback(async (sale: QueuedSale) => {
    await removeSale(sale.id);
    await enqueue({ id: sale.id, items: sale.items, createdAt: sale.createdAt });
    if (navigator.onLine) void drainQueue();
  }, [enqueue, removeSale, drainQueue]);

  const handleEditFailed = useCallback((sale: QueuedSale) => {
    // Load items back into cart for editing
    setCartItems(sale.items);
    void removeSale(sale.id);
  }, [removeSale]);

  const handleDiscardFailed = useCallback((sale: QueuedSale) => {
    void removeSale(sale.id);
  }, [removeSale]);

  const failedSales = queuedSales.filter((s) => s.status === "failed");

  return (
    <div className="flex h-dvh flex-col bg-surface-1">
      {/* Header */}
      <header className="flex shrink-0 items-center justify-between border-b border-line bg-surface-0 px-4 py-3">
        <h1 className="text-lg font-bold text-ink-900">{t("pos.title")}</h1>
        <SyncPill status={syncStatus} count={queuedCount} />
      </header>

      {/* Failed sale errors */}
      {failedSales.length > 0 && (
        <div className="shrink-0 space-y-1 bg-danger-600/5 px-4 py-2">
          {failedSales.map((sale) => (
            <div key={sale.id} className="flex items-center gap-2 rounded border border-danger-600/20 bg-surface-0 px-3 py-2 text-sm">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-danger-600">
                  {t("pos.queueErrorTitle", { name: sale.items.map((i) => i.itemName).join(", ") })}
                </p>
                <p className="text-xs text-ink-400">
                  {sale.errorStatus === 422 ? t("pos.queueErrorBody422") : t("pos.queueErrorBody400")}
                </p>
              </div>
              <div className="flex gap-1">
                <button
                  onClick={() => handleRetryFailed(sale)}
                  className="touch-target rounded bg-gezi-green-700 px-3 text-xs font-medium text-white hover:bg-gezi-green-900"
                >
                  {t("pos.queueErrorRetry")}
                </button>
                <button
                  onClick={() => handleEditFailed(sale)}
                  className="touch-target rounded border border-line px-3 text-xs font-medium text-ink-600 hover:bg-surface-1"
                >
                  {t("pos.queueErrorEdit")}
                </button>
                <button
                  onClick={() => handleDiscardFailed(sale)}
                  className="touch-target rounded border border-line px-3 text-xs font-medium text-danger-600 hover:bg-danger-600/10"
                >
                  {t("pos.queueErrorDiscard")}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: item grid */}
        <div className="flex-1 overflow-y-auto p-4">
          <ItemGrid items={inventory} onAddToCart={handleAddToCart} loading={isLoading} />
        </div>

        {/* Right / bottom: cart */}
        <div className="hidden w-80 shrink-0 border-l border-line bg-surface-0 p-4 sm:block">
          <Cart
            items={cartItems}
            onUpdateQty={handleUpdateQty}
            onUpdatePrice={handleUpdatePrice}
            onRemove={handleRemove}
            onCharge={handleCharge}
          />
        </div>
      </div>

      {/* Mobile cart (bottom sheet) */}
      <div className="sm:hidden border-t border-line bg-surface-0 p-4">
        <Cart
          items={cartItems}
          onUpdateQty={handleUpdateQty}
          onUpdatePrice={handleUpdatePrice}
          onRemove={handleRemove}
          onCharge={handleCharge}
        />
      </div>
    </div>
  );
}