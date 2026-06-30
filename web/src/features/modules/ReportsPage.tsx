import type React from "react";
import { lazy, Suspense } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { Money } from "@/components/Money";
import { listPurchases, listSales, type PurchaseRecord, type SaleRecord } from "@/lib/api";

import { EmptyState, ErrorState, EXPORT_PAGE_SIZE, Field, PageHeader, SkeletonRows, rangeFromDays } from "./ModuleUtils";
import type { ReportPoint } from "./ReportsCharts";

const ReportsCharts = lazy(() => import("./ReportsCharts"));

type ReportsData = {
  sales: SaleRecord[];
  purchases: PurchaseRecord[];
  daily: ReportPoint[];
  weekly: ReportPoint[];
  monthly: ReportPoint[];
};

async function fetchAllSales(from: string, to: string): Promise<SaleRecord[]> {
  const first = await listSales({ from, to, page: 1, perPage: EXPORT_PAGE_SIZE });
  const total = first.meta?.total ?? first.data.length;
  const rows = [...first.data];
  const pages = Math.ceil(total / EXPORT_PAGE_SIZE);
  for (let page = 2; page <= pages; page += 1) rows.push(...(await listSales({ from, to, page, perPage: EXPORT_PAGE_SIZE })).data);
  return rows;
}

async function fetchAllPurchases(from: string, to: string): Promise<PurchaseRecord[]> {
  const first = await listPurchases({ from, to, page: 1, perPage: EXPORT_PAGE_SIZE });
  const total = first.meta?.total ?? first.data.length;
  const rows = [...first.data];
  const pages = Math.ceil(total / EXPORT_PAGE_SIZE);
  for (let page = 2; page <= pages; page += 1) rows.push(...(await listPurchases({ from, to, page, perPage: EXPORT_PAGE_SIZE })).data);
  return rows;
}

function keyFor(date: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Kampala" }).format(new Date(date));
}

function labelFor(date: Date): string {
  return new Intl.DateTimeFormat("en-UG", { day: "2-digit", month: "short", timeZone: "Africa/Kampala" }).format(date);
}

function buildDaily(sales: SaleRecord[], purchases: PurchaseRecord[]): ReportPoint[] {
  const range = rangeFromDays(7);
  const start = new Date(range.from);
  const points = Array.from({ length: 7 }, (_, index) => {
    const day = new Date(start.getTime() + index * 24 * 60 * 60 * 1000 + 3 * 60 * 60 * 1000);
    return { key: day.toISOString().slice(0, 10), label: labelFor(day), salesUgx: 0, purchasesUgx: 0 };
  });
  const byKey = new Map(points.map((point) => [point.key, point]));
  sales.forEach((sale) => { const point = byKey.get(keyFor(sale.createdAt)); if (point) point.salesUgx += sale.totalPrice; });
  purchases.forEach((purchase) => { const point = byKey.get(keyFor(purchase.createdAt)); if (point) point.purchasesUgx += purchase.totalPrice; });
  return points;
}

function buildWeekly(sales: SaleRecord[], purchases: PurchaseRecord[]): ReportPoint[] {
  const range = rangeFromDays(30);
  const start = new Date(range.from);
  const points = Array.from({ length: 5 }, (_, index) => {
    const weekStart = new Date(start.getTime() + index * 7 * 24 * 60 * 60 * 1000 + 3 * 60 * 60 * 1000);
    return { label: labelFor(weekStart), salesUgx: 0, purchasesUgx: 0 };
  });
  const add = (createdAt: string, amount: number, key: "salesUgx" | "purchasesUgx"): void => {
    const diff = Math.max(0, new Date(createdAt).getTime() - start.getTime());
    const index = Math.min(4, Math.floor(diff / (7 * 24 * 60 * 60 * 1000)));
    points[index]![key] += amount;
  };
  sales.forEach((sale) => add(sale.createdAt, sale.totalPrice, "salesUgx"));
  purchases.forEach((purchase) => add(purchase.createdAt, purchase.totalPrice, "purchasesUgx"));
  return points;
}

function buildMonthly(sales: SaleRecord[], purchases: PurchaseRecord[]): ReportPoint[] {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-UG", { month: "short", year: "numeric", timeZone: "Africa/Kampala" });
  const currentLabel = formatter.format(now);
  const previous = new Date(now);
  previous.setMonth(previous.getMonth() - 1);
  const previousLabel = formatter.format(previous);
  const points: ReportPoint[] = [
    { label: previousLabel, salesUgx: 0, purchasesUgx: 0 },
    { label: currentLabel, salesUgx: 0, purchasesUgx: 0 }
  ];
  const currentMonth = new Intl.DateTimeFormat("en-CA", { month: "2-digit", year: "numeric", timeZone: "Africa/Kampala" }).format(now);
  const add = (createdAt: string, amount: number, key: "salesUgx" | "purchasesUgx"): void => {
    const month = new Intl.DateTimeFormat("en-CA", { month: "2-digit", year: "numeric", timeZone: "Africa/Kampala" }).format(new Date(createdAt));
    points[month === currentMonth ? 1 : 0]![key] += amount;
  };
  sales.forEach((sale) => add(sale.createdAt, sale.totalPrice, "salesUgx"));
  purchases.forEach((purchase) => add(purchase.createdAt, purchase.totalPrice, "purchasesUgx"));
  return points;
}

async function fetchReportsData(): Promise<ReportsData> {
  const thirty = rangeFromDays(30);
  const [sales, purchases] = await Promise.all([fetchAllSales(thirty.from, thirty.to), fetchAllPurchases(thirty.from, thirty.to)]);
  return { sales, purchases, daily: buildDaily(sales, purchases), weekly: buildWeekly(sales, purchases), monthly: buildMonthly(sales, purchases) };
}

export function ReportsPage(): React.ReactElement {
  const { t } = useTranslation();
  const query = useQuery({ queryKey: ["reports", "composed", "30-day"], queryFn: fetchReportsData });

  if (query.isLoading) return <SkeletonRows />;
  if (query.isError || !query.data) return <ErrorState title={t("reports.errorTitle")} body={t("common.errorBody")} onRetry={() => void query.refetch()} />;

  const salesTotal = query.data.sales.reduce((sum, sale) => sum + sale.totalPrice, 0);
  const purchasesTotal = query.data.purchases.reduce((sum, purchase) => sum + purchase.totalPrice, 0);

  return (
    <div className="space-y-4">
      <PageHeader title={t("reports.title")} total={t("reports.total")} endpoint="Composed from GET /api/v1/sales + GET /api/v1/purchases" />
      <div className="rounded-lg border border-warn-600 bg-surface-0 p-4 text-sm font-semibold text-warn-600">{t("reports.endpointGap")}</div>
      <section className="grid gap-3 sm:grid-cols-2">
        <Field label={t("reports.sales30")} value={<Money amount={salesTotal} size="card" tone="positive" />} money />
        <Field label={t("reports.purchases30")} value={<Money amount={purchasesTotal} size="card" />} money />
      </section>
      {query.data.sales.length === 0 && query.data.purchases.length === 0 ? <EmptyState message={t("reports.empty")} /> : null}
      <Suspense fallback={<SkeletonRows />}>
        <ReportsCharts
          daily={query.data.daily}
          weekly={query.data.weekly}
          monthly={query.data.monthly}
          labels={{
            daily: t("reports.daily"),
            weekly: t("reports.weekly"),
            monthly: t("reports.monthly"),
            sales: t("reports.sales"),
            purchases: t("reports.purchases"),
            highest: t("today.highestLabel")
          }}
        />
      </Suspense>
    </div>
  );
}
