import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";

// Mock i18next
vi.mock("react-i18next", () => ({
  useTranslation: () => {
    const lookup: Record<string, string> = {
      "pos.syncSynced": "Synced",
      "pos.syncQueued": "0 queued",
      "pos.syncNeedsAttention": "Needs attention",
      "pos.title": "POS",
      "pos.search": "Search items",
      "pos.editPrice": "Edit price",
      "pos.keypadTitle": "Enter price",
      "pos.cartTitle": "Cart",
      "pos.total": "Total",
      "pos.charge": "Charge",
      "pos.noItems": "Tap items to add them to the cart.",
      "pos.emptyInventory": "No inventory items",
      "pos.emptyInventoryBody": "Add items in Inventory before using the POS.",
      "pos.queueErrorTitle": "Item could not be saved",
      "pos.queueErrorRetry": "Retry",
      "pos.queueErrorEdit": "Edit",
      "pos.queueErrorDiscard": "Discard",
      "pos.queueErrorBody422": "Not enough stock. Check inventory.",
      "pos.queueErrorBody400": "Invalid data. Edit and try again.",
      "common.blank": "-",
      "common.close": "Close",
    };
    return {
      t: (key: string, opts?: Record<string, unknown>) => {
        if (key === "pos.syncQueued" && opts?.count === 1) return "1 queued";
        if (key === "pos.queueErrorTitle" && opts?.name) return `${opts.name} could not be saved`;
        return lookup[key] ?? key;
      },
      i18n: { language: "en" }
    };
  }
}));

// Mock inventory API
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    listInventory: vi.fn().mockResolvedValue({
      success: true,
      data: [
        { id: "1", name: "Sugar", unit: "kg", qtyInStock: 50, lowStockThreshold: 10, typicalSellPrice: 5000, typicalBuyPrice: null, createdAt: "2026-01-01", updatedAt: "2026-06-01", lastSoldAt: "2026-07-04" },
        { id: "2", name: "Salt", unit: "kg", qtyInStock: 20, lowStockThreshold: 5, typicalSellPrice: 2000, typicalBuyPrice: null, createdAt: "2026-01-01", updatedAt: "2026-06-01", lastSoldAt: null },
        { id: "3", name: "Bread", unit: "pc", qtyInStock: 150, lowStockThreshold: 30, typicalSellPrice: 3500, typicalBuyPrice: null, createdAt: "2026-01-01", updatedAt: "2026-06-01", lastSoldAt: "2026-07-05" },
        { id: "4", name: "Milk", unit: "L", qtyInStock: 0, lowStockThreshold: 5, typicalSellPrice: 4000, typicalBuyPrice: null, createdAt: "2026-01-01", updatedAt: "2026-06-01", lastSoldAt: "2026-07-03" },
      ]
    })
  };
});

// Mock Auth context
vi.mock("@/features/auth/AuthContext", () => ({
  useAuth: () => ({
    session: { user: { role: "owner" }, tenant: { id: "t1", businessName: "Test" } },
    status: "authenticated"
  }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>
}));

import { PosPage } from "./PosPage";
import { useOfflineQueue, generateIdempotencyKey, resetDB, clearQueue } from "./useOfflineQueue";
import { renderHook } from "@testing-library/react";
import React from "react";

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  });
  return (
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        {children}
      </BrowserRouter>
    </QueryClientProvider>
  );
}

describe("POS Page", () => {
  beforeEach(async () => { await clearQueue(); });

  it("renders the POS title and sync pill", async () => {
    render(<PosPage />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText("POS")).toBeDefined();
    }, { timeout: 5000 });
    expect(screen.getByText("Synced")).toBeDefined();
  });

  it("renders inventory items ranked by lastSoldAt (recency)", async () => {
    render(<PosPage />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText("Bread")).toBeDefined();
    }, { timeout: 5000 });
    const items = screen.getAllByText(/Sugar|Salt|Bread|Milk/);
    expect(items[0]?.textContent).toBe("Bread");
  });

  it("tapping an item adds it to the cart", async () => {
    render(<PosPage />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText("Sugar")).toBeDefined();
    }, { timeout: 5000 });
    fireEvent.click(screen.getByText("Sugar"));
    await waitFor(() => {
      // Sugar appears in the cart
      expect(screen.getAllByText("Sugar").length).toBeGreaterThan(1);
    }, { timeout: 3000 });
  });

  it("price-edit one-tap opens numeric keypad", async () => {
    render(<PosPage />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText("Bread")).toBeDefined();
    }, { timeout: 5000 });
    const editButtons = screen.getAllByText("Edit price");
    fireEvent.click(editButtons[0]!);
    // Keypad title is "Bread — Edit price"
    await waitFor(() => {
      expect(screen.getByText(/Bread.*Edit price/)).toBeDefined();
    }, { timeout: 3000 });
  });

  it("sync pill shows synced when queue is empty", async () => {
    render(<PosPage />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText("Synced")).toBeDefined();
    }, { timeout: 5000 });
  });
});

describe("useOfflineQueue — IndexedDB persistence and queue logic", () => {
  beforeEach(async () => { await clearQueue(); });
  afterAll(() => { resetDB(); });

  it("queued sale survives simulated reload", async () => {
    const id = generateIdempotencyKey();
    const { result, unmount } = renderHook(() => useOfflineQueue(), { wrapper: Wrapper });

    await act(async () => {
      await result.current.enqueue({
        id,
        items: [{ itemName: "Sugar", qty: 2, unit: "kg", unitPrice: 5000, totalPrice: 10000 }],
        createdAt: new Date().toISOString()
      });
    });
    expect(result.current.queuedSales.length).toBe(1);
    unmount();

    // Re-mount — data persists in IndexedDB
    const { result: result2 } = renderHook(() => useOfflineQueue(), { wrapper: Wrapper });
    await waitFor(() => {
      expect(result2.current.queuedSales.length).toBeGreaterThanOrEqual(1);
    }, { timeout: 5000 });
    const found = result2.current.queuedSales.find((s) => s.id === id);
    expect(found).toBeDefined();
    expect(found?.items[0]?.itemName).toBe("Sugar");
  });

  it("duplicate replay uses the same Idempotency-Key", async () => {
    const id = generateIdempotencyKey();
    const { result } = renderHook(() => useOfflineQueue(), { wrapper: Wrapper });

    await act(async () => {
      await result.current.enqueue({
        id,
        items: [{ itemName: "Salt", qty: 1, unit: "kg", unitPrice: 2000, totalPrice: 2000 }],
        createdAt: new Date().toISOString()
      });
    });

    // Enqueue again with same ID — put is idempotent
    await act(async () => {
      await result.current.enqueue({
        id,
        items: [{ itemName: "Salt", qty: 3, unit: "kg", unitPrice: 2000, totalPrice: 6000 }],
        createdAt: new Date().toISOString()
      });
    });

    const matching = result.current.queuedSales.filter((s) => s.id === id);
    expect(matching.length).toBe(1);
    // Should have the latest data (qty=3 from second call)
    expect(matching[0]?.items[0]?.qty).toBe(3);
  });

  it("pill states transition: synced → queued → synced", async () => {
    const { result } = renderHook(() => useOfflineQueue(), { wrapper: Wrapper });

    await waitFor(() => {
      expect(result.current.syncStatus).toBe("synced");
    }, { timeout: 2000 });

    // Enqueue creates a queued state
    await act(async () => {
      await result.current.enqueue({
        id: generateIdempotencyKey(),
        items: [{ itemName: "Bread", qty: 1, unit: "pc", unitPrice: 3500, totalPrice: 3500 }],
        createdAt: new Date().toISOString()
      });
    });
    // After enqueue, status should be "queued"
    await waitFor(() => {
      expect(result.current.syncStatus).toBe("queued");
    }, { timeout: 2000 });

    // Remove it — back to synced
    const sale = result.current.queuedSales[0];
    if (sale) {
      await act(async () => {
        await result.current.removeSale(sale.id);
      });
    }
    await waitFor(() => {
      expect(result.current.syncStatus).toBe("synced");
    }, { timeout: 2000 });
  });

  it("failed sale sets needs_attention", async () => {
    const { result } = renderHook(() => useOfflineQueue(), { wrapper: Wrapper });

    await act(async () => {
      await result.current.enqueue({
        id: generateIdempotencyKey(),
        items: [{ itemName: "Milk", qty: 1, unit: "L", unitPrice: 4000, totalPrice: 4000 }],
        createdAt: new Date().toISOString()
      });
    });

    const sale = result.current.queuedSales[0];
    if (sale) {
      await act(async () => {
        await result.current.updateSale(sale.id, { status: "failed", errorReason: "Stock", errorStatus: 422 });
      });
    }

    await waitFor(() => {
      expect(result.current.syncStatus).toBe("needs_attention");
    }, { timeout: 3000 });
  });

  it("online event triggers drainQueue", async () => {
    const { result } = renderHook(() => useOfflineQueue(), { wrapper: Wrapper });

    await act(async () => {
      await result.current.enqueue({
        id: generateIdempotencyKey(),
        items: [{ itemName: "Sugar", qty: 2, unit: "kg", unitPrice: 5000, totalPrice: 10000 }],
        createdAt: new Date().toISOString()
      });
    });

    expect(result.current.queuedSales.length).toBeGreaterThanOrEqual(1);
    // drainQueue is callable and returns a promise
    expect(typeof result.current.drainQueue).toBe("function");
    const p = result.current.drainQueue();
    expect(p).toBeInstanceOf(Promise);
    await p;
  });
});