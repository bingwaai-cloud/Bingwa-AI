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
  updatedAt: "2026-06-30T06:32:00.000Z"
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

  it("renders Inventory without a dead search box and flags missing API support", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/v1/inventory") return envelope([{ ...inventoryItem, typicalSellPrice: undefined }], { total: 1, lowStockCount: 1 });
      if (url.pathname === "/api/v1/inventory/low-stock") return envelope([inventoryItem], { total: 1 });
      throw new Error(`Unexpected request ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithClient(<InventoryPage />);

    expect(await screen.findByText("Inventory")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByText(/ignores search\/query parameters/)).toBeInTheDocument();
    expect(screen.getByText(/does not provide last-sold/)).toBeInTheDocument();
    expect(screen.getByText(/Some inventory rows omit/)).toBeInTheDocument();
  });

  it("uses customer search and flags the absent purchase-history endpoint", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/v1/customers") return envelope([customer], { total: 1, page: Number(url.searchParams.get("page") ?? 1), perPage: 20 });
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
    expect(screen.getByText(/GET \/api\/v1\/customers\/:id\/purchases is not present/)).toBeInTheDocument();
  });

  it("composes Reports from existing list endpoints only", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/v1/sales") return envelope([sale("report")], { total: 1, page: 1, perPage: 100 });
      if (url.pathname === "/api/v1/purchases") return envelope([purchase], { total: 1, page: 1, perPage: 100 });
      throw new Error(`Unexpected request ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithClient(<ReportsPage />);

    expect(await screen.findByText("Reports")).toBeInTheDocument();
    expect(await screen.findByText("Daily summary, 7 days")).toBeInTheDocument();
    const paths = fetchMock.mock.calls.map(([input]) => new URL(String(input), "http://localhost").pathname);
    expect(paths).toContain("/api/v1/sales");
    expect(paths).toContain("/api/v1/purchases");
    expect(paths.some((path) => path.includes("/reports"))).toBe(false);
  });

  it("renders longer Luganda labels on the read-only tables", async () => {
    await i18n.changeLanguage("lg");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/v1/customers") return envelope([customer], { total: 1, page: 1, perPage: 20 });
      throw new Error(`Unexpected request ${url.pathname}`);
    }));

    renderWithClient(<CustomersPage />);

    expect(await screen.findByText("Bakiriya ba bizinensi yo")).toBeInTheDocument();
    expect(screen.getByText("Omugatte gw ebyagula")).toBeInTheDocument();
  });
});

