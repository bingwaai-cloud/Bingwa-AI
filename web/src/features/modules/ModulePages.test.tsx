import "@/i18n";

import type React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import i18n from "i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CustomersPage } from "./CustomersPage";
import { InventoryPage } from "./InventoryPage";
import { ReportsPage } from "./ReportsPage";
import { SalesPage } from "./SalesPage";

vi.mock("recharts", () => ({
  Bar: () => <div data-testid="bar" />,
  BarChart: ({ children }: { children: React.ReactNode }) => <div data-testid="bar-chart">{children}</div>,
  CartesianGrid: () => <div data-testid="grid" />,
  Line: () => <div data-testid="line" />,
  LineChart: ({ children }: { children: React.ReactNode }) => <div data-testid="line-chart">{children}</div>,
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Tooltip: () => <div data-testid="tooltip" />,
  XAxis: () => <div data-testid="x-axis" />,
  YAxis: () => <div data-testid="y-axis" />
}));

function envelope<T>(data: T, meta?: Record<string, number>): Response {
  return new Response(JSON.stringify({ success: true, data, meta }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function renderWithClient(element: React.ReactElement): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}

const sale = (id: string, totalPrice = 6000) => ({
  id,
  itemName: "Sugar",
  qty: 2,
  unitPrice: 3000,
  totalPrice,
  source: "whatsapp",
  createdAt: "2026-06-30T08:32:00.000Z",
  lines: [{ id: `${id}-line`, itemName: "Sugar", qty: 2, unit: "kg", unitPrice: 3000, totalPrice, createdAt: "2026-06-30T08:32:00.000Z" }]
});

const purchase = {
  id: "purchase-1",
  itemName: "Soap",
  qty: 4,
  unitPrice: 1000,
  totalPrice: 4000,
  source: "web",
  createdAt: "2026-06-29T07:32:00.000Z"
};

const inventoryItem = {
  id: "item-1",
  name: "Sugar",
  unit: "kg",
  qtyInStock: 3,
  lowStockThreshold: 5,
  typicalSellPrice: 3000,
  createdAt: "2026-06-30T06:32:00.000Z",
  updatedAt: "2026-06-30T06:32:00.000Z",
  lastSoldAt: "2026-06-30T08:32:00.000Z"
};

const customer = {
  id: "customer-1",
  name: "Nakato",
  phone: "+256771234567",
  notes: null,
  visitCount: 3,
  totalPurchases: 18000,
  lastVisitedAt: "2026-06-30T08:32:00.000Z",
  optedInMarketing: true,
  createdAt: "2026-06-01T08:32:00.000Z",
  updatedAt: "2026-06-30T08:32:00.000Z"
};

describe("read-only module pages", () => {
  beforeEach(() => {
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:csv") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  });

  afterEach(async () => {
    await i18n.changeLanguage("en");
    vi.unstubAllGlobals();
  });

  it("exports the full filtered sales dataset, not only page one", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/v1/sales") {
        const perPage = Number(url.searchParams.get("perPage"));
        const page = Number(url.searchParams.get("page"));
        if (perPage === 20) return envelope([sale("visible")], { total: 101, page: 1, perPage: 20 });
        if (page === 1) return envelope([sale("export-1")], { total: 101, page: 1, perPage: 100 });
        if (page === 2) return envelope([sale("export-2")], { total: 101, page: 2, perPage: 100 });
      }
      throw new Error(`Unexpected request ${url.pathname}${url.search}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithClient(<SalesPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Export CSV" }));

    await waitFor(() => {
      const exportCalls = fetchMock.mock.calls
        .map(([input]) => new URL(String(input), "http://localhost"))
        .filter((url) => url.pathname === "/api/v1/sales" && url.searchParams.get("perPage") === "100");
      expect(exportCalls.map((url) => url.searchParams.get("page"))).toEqual(["1", "2"]);
      expect(exportCalls.every((url) => url.searchParams.has("from") && url.searchParams.has("to"))).toBe(true);
    });
  });

  it("uses backend inventory pagination and search", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/v1/inventory") return envelope([inventoryItem], { total: 1, page: Number(url.searchParams.get("page") ?? 1), perPage: Number(url.searchParams.get("perPage") ?? 20), lowStockCount: 1 });
      if (url.pathname === "/api/v1/inventory/low-stock") return envelope([inventoryItem], { total: 1 });
      throw new Error(`Unexpected request ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithClient(<InventoryPage />);

    expect(await screen.findByText("Inventory")).toBeInTheDocument();
    expect(await screen.findByText("30 Jun 2026, 11:32")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("Search inventory"), { target: { value: "Sugar" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    await waitFor(() => {
      const searched = fetchMock.mock.calls.some(([input]) => {
        const url = new URL(String(input), "http://localhost");
        return url.pathname === "/api/v1/inventory" && url.searchParams.get("search") === "Sugar";
      });
      expect(searched).toBe(true);
    });
  });

  it("uses customer search and loads purchase history on drill-down", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/v1/customers") return envelope([customer], { total: 1, page: Number(url.searchParams.get("page") ?? 1), perPage: 20 });
      if (url.pathname === "/api/v1/customers/customer-1/purchases") return envelope([sale("customer-sale")], { total: 1, page: 1, perPage: 5 });
      throw new Error(`Unexpected request ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithClient(<CustomersPage />);
    fireEvent.change(await screen.findByPlaceholderText("Search customers"), { target: { value: "Nakato" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    await waitFor(() => {
      const searched = fetchMock.mock.calls.some(([input]) => new URL(String(input), "http://localhost").searchParams.get("search") === "Nakato");
      expect(searched).toBe(true);
    });
    fireEvent.click(await screen.findByText("Nakato"));
    expect(await screen.findByText("Purchase history")).toBeInTheDocument();
    expect(await screen.findByText("Sugar")).toBeInTheDocument();
  });

  it("reads Reports from server summary endpoints only", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/v1/sales/summary") return envelope({ groupBy: url.searchParams.get("groupBy"), from: "2026-06-01T00:00:00.000Z", to: "2026-06-30T00:00:00.000Z", buckets: [{ periodStart: "2026-06-30T00:00:00.000Z", totalUgx: 6000, count: 1 }], totalUgx: 6000, count: 1 });
      if (url.pathname === "/api/v1/purchases/summary") return envelope({ groupBy: url.searchParams.get("groupBy"), from: "2026-06-01T00:00:00.000Z", to: "2026-06-30T00:00:00.000Z", buckets: [{ periodStart: "2026-06-30T00:00:00.000Z", totalUgx: 4000, count: 1 }], totalUgx: 4000, count: 1 });
      throw new Error(`Unexpected request ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithClient(<ReportsPage />);

    expect(await screen.findByText("Reports")).toBeInTheDocument();
    expect(await screen.findByText("Daily summary, 7 days")).toBeInTheDocument();
    const paths = fetchMock.mock.calls.map(([input]) => new URL(String(input), "http://localhost").pathname);
    expect(paths).toContain("/api/v1/sales/summary");
    expect(paths).toContain("/api/v1/purchases/summary");
    expect(paths).not.toContain("/api/v1/sales");
    expect(paths).not.toContain("/api/v1/purchases");
  });

  it("renders longer Luganda labels on the read-only tables", async () => {
    await i18n.changeLanguage("lg");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/v1/customers") return envelope([customer], { total: 1, page: 1, perPage: 20 });
      if (url.pathname === "/api/v1/customers/customer-1/purchases") return envelope([], { total: 0, page: 1, perPage: 5 });
      throw new Error(`Unexpected request ${url.pathname}`);
    }));

    renderWithClient(<CustomersPage />);

    expect(await screen.findByText("Bakiriya ba bizinensi yo")).toBeInTheDocument();
    expect(screen.getByText("Omugatte gw ebyagula")).toBeInTheDocument();
  });
});

