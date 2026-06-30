import type React from "react";
import { lazy, Suspense } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { Money } from "@/components/Money";
import { getPurchasesSummary, getSalesSummary, type SummaryResponse } from "@/lib/api";

import { EmptyState, ErrorState, Field, PageHeader, SkeletonRows, rangeFromDays } from "./ModuleUtils";
import type { ReportPoint } from "./ReportsCharts";

const ReportsCharts = lazy(() => import("./ReportsCharts"));

type ReportsData = {
  sales30: SummaryResponse;
  purchases30: SummaryResponse;
  daily: ReportPoint[];
  weekly: ReportPoint[];
  monthly: ReportPoint[];
};

function labelFor(date: string, groupBy: "day" | "week" | "month"): string {
  const value = new Date(date);
  if (groupBy === "month") return new Intl.DateTimeFormat("en-UG", { month: "short", year: "numeric", timeZone: "Africa/Kampala" }).format(value);
  return new Intl.DateTimeFormat("en-UG", { day: "2-digit", month: "short", timeZone: "Africa/Kampala" }).format(value);
}

function combineSummaries(sales: SummaryResponse, purchases: SummaryResponse): ReportPoint[] {
  const byPeriod = new Map<string, ReportPoint>();
  sales.buckets.forEach((bucket) => {
    byPeriod.set(bucket.periodStart, { label: labelFor(bucket.periodStart, sales.groupBy), salesUgx: bucket.totalUgx, purchasesUgx: 0 });
  });
  purchases.buckets.forEach((bucket) => {
    const existing = byPeriod.get(bucket.periodStart) ?? { label: labelFor(bucket.periodStart, purchases.groupBy), salesUgx: 0, purchasesUgx: 0 };
    existing.purchasesUgx = bucket.totalUgx;
    byPeriod.set(bucket.periodStart, existing);
  });
  return [...byPeriod.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, point]) => point);
}

async function fetchReportsData(): Promise<ReportsData> {
  const seven = rangeFromDays(7);
  const thirty = rangeFromDays(30);
  const [sales7, purchases7, sales30, purchases30, salesMonthly, purchasesMonthly] = await Promise.all([
    getSalesSummary({ ...seven, groupBy: "day" }),
    getPurchasesSummary({ ...seven, groupBy: "day" }),
    getSalesSummary({ ...thirty, groupBy: "week" }),
    getPurchasesSummary({ ...thirty, groupBy: "week" }),
    getSalesSummary({ ...thirty, groupBy: "month" }),
    getPurchasesSummary({ ...thirty, groupBy: "month" })
  ]);
  return {
    sales30,
    purchases30,
    daily: combineSummaries(sales7, purchases7),
    weekly: combineSummaries(sales30, purchases30),
    monthly: combineSummaries(salesMonthly, purchasesMonthly)
  };
}

export function ReportsPage(): React.ReactElement {
  const { t } = useTranslation();
  const query = useQuery({ queryKey: ["reports", "summary", "server"], queryFn: fetchReportsData });

  if (query.isLoading) return <SkeletonRows />;
  if (query.isError || !query.data) return <ErrorState title={t("reports.errorTitle")} body={t("common.errorBody")} onRetry={() => void query.refetch()} />;

  const salesTotal = query.data.sales30.totalUgx;
  const purchasesTotal = query.data.purchases30.totalUgx;
  const empty = salesTotal === 0 && purchasesTotal === 0;

  return (
    <div className="space-y-4">
      <PageHeader title={t("reports.title")} total={t("reports.total")} endpoint="GET /api/v1/sales/summary + GET /api/v1/purchases/summary" />
      <section className="grid gap-3 sm:grid-cols-2">
        <Field label={t("reports.sales30")} value={<Money amount={salesTotal} size="card" tone="positive" />} money />
        <Field label={t("reports.purchases30")} value={<Money amount={purchasesTotal} size="card" />} money />
      </section>
      {empty ? <EmptyState message={t("reports.empty")} /> : null}
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
