import "@/i18n";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type React from "react";
import { vi } from "vitest";

import { TodayPage } from "./TodayPage";

vi.mock("recharts", () => ({
  Line: () => <div data-testid="line" />,
  LineChart: ({ children }: { children: React.ReactNode }) => <div data-testid="line-chart">{children}</div>,
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Tooltip: () => <div data-testid="tooltip" />,
  XAxis: () => <div data-testid="x-axis" />,
  YAxis: () => <div data-testid="y-axis" />
}));

const sale = {
  id: "sale-1",
  itemName: "Sugar",
  qty: 2,
  unitPrice: 3000,
  totalPrice: 6000,
  source: "whatsapp",
  createdAt: "2026-06-30T08:32:00.000Z",
  lines: []
};
const purchase = {
  id: "purchase-1",
  itemName: "Soap",
  qty: 4,
  unitPrice: 1000,
  totalPrice: 4000,
  source: "web",
  createdAt: "2026-06-30T07:32:00.000Z"
};
const lowStock = {
  id: "item-1",
  name: "Sugar",
  unit: "bags",
  qtyInStock: 3,
  lowStockThreshold: 5,
  createdAt: "2026-06-30T06:32:00.000Z"
};
const draft = {
  id: "draft-1",
  userPhone: "+256771234567",
  action: "sale",
  payload: { action: "sale", items: [{ item: "sugar", qty: 2, unitPrice: 3000, totalPrice: 6000 }] },
  state: "parsed",
  clarificationQuestion: null,
  committedEntityId: null,
  expiresAt: "2026-07-01T06:32:00.000Z",
  createdAt: "2026-06-30T08:32:00.000Z",
  updatedAt: "2026-06-30T08:32:00.000Z"
};

function envelope<T>(data: T, meta?: Record<string, number>): Response {
  return new Response(JSON.stringify({ success: true, data, meta }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

function renderToday(): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TodayPage />
    </QueryClientProvider>
  );
  return client;
}

function mockFetch(records: { draftState?: string; saleCount?: number } = {}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/v1/sales/summary/today") return envelope({ totalRevenue: records.saleCount === 0 ? 0 : 6000, saleCount: records.saleCount ?? 1 });
    if (url.pathname === "/api/v1/sales") return envelope(records.saleCount === 0 ? [] : [sale], { total: records.saleCount === 0 ? 0 : 1, page: 1, perPage: 100 });
    if (url.pathname === "/api/v1/purchases") return envelope([purchase], { total: 1, page: 1, perPage: 100 });
    if (url.pathname === "/api/v1/inventory/low-stock") return envelope([lowStock], { total: 1 });
    if (url.pathname === "/api/v1/drafts") return envelope([{ ...draft, state: records.draftState ?? "parsed" }], { total: 1, page: 1, perPage: 20 });
    if (url.pathname === "/api/v1/drafts/draft-1/confirm" && init?.method === "POST") return envelope({ ok: true });
    throw new Error(`Unexpected request ${url.pathname}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("TodayPage", () => {
  beforeEach(() => {
    Object.defineProperty(window.navigator, "onLine", { configurable: true, value: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads Today from existing /api/v1 endpoints and renders the required sections", async () => {
    const fetchMock = mockFetch();
    renderToday();

    expect(await screen.findByText("Today's sales")).toBeInTheDocument();
    expect(screen.getAllByText("UGX 6,000").length).toBeGreaterThan(0);
    expect(screen.getByText("Cash in")).toBeInTheDocument();
    expect(screen.getByText("Cash out")).toBeInTheDocument();
    expect(screen.getByText("Low-stock alerts")).toBeInTheDocument();
    expect(screen.getByText("Open drafts from WhatsApp")).toBeInTheDocument();
    expect(await screen.findByText("7-day sales")).toBeInTheDocument();

    const paths = fetchMock.mock.calls.map(([input]) => new URL(String(input), "http://localhost").pathname);
    expect(paths).toContain("/api/v1/sales/summary/today");
    expect(paths).toContain("/api/v1/sales");
    expect(paths).toContain("/api/v1/purchases");
    expect(paths).toContain("/api/v1/inventory/low-stock");
    expect(paths).toContain("/api/v1/drafts");
  });

  it("shows the WhatsApp empty state when there are no sales today", async () => {
    mockFetch({ saleCount: 0 });
    renderToday();

    expect(await screen.findByText("No sales yet today \u2014 send 'sold 2 sugar 6k' to your Gezi number.")).toBeInTheDocument();
  });

  it("shows the offline cached-data banner", async () => {
    Object.defineProperty(window.navigator, "onLine", { configurable: true, value: false });
    mockFetch();
    renderToday();

    expect(await screen.findByText("Offline \u2014 showing last synced")).toBeInTheDocument();
  });

  it("confirms an actionable draft through the real draft endpoint", async () => {
    const fetchMock = mockFetch();
    renderToday();

    fireEvent.click(await screen.findByText("2 sugar"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/drafts/draft-1/confirm",
        expect.objectContaining({ method: "POST" })
      );
    });
  });

  it("does not offer illegal write actions for an immutable draft state", async () => {
    mockFetch({ draftState: "committed" });
    renderToday();

    fireEvent.click(await screen.findByText("2 sugar"));
    const dialog = screen.getByRole("dialog", { name: "WhatsApp draft" });
    expect(within(dialog).queryByRole("button", { name: "Confirm" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Amend" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    expect(within(dialog).getByText("This draft is no longer editable.")).toBeInTheDocument();
  });
});
