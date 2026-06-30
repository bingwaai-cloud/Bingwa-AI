import type React from "react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { Money } from "@/components/Money";

export type ReportPoint = {
  label: string;
  salesUgx: number;
  purchasesUgx: number;
};

type ReportsChartsProps = {
  daily: ReportPoint[];
  weekly: ReportPoint[];
  monthly: ReportPoint[];
  labels: {
    daily: string;
    weekly: string;
    monthly: string;
    sales: string;
    purchases: string;
    highest: string;
  };
};

function formatAxisUgx(value: number): string {
  if (value >= 1_000_000) return `UGX ${Math.round(value / 1_000_000)}m`;
  if (value >= 1_000) return `UGX ${Math.round(value / 1_000)}k`;
  return `UGX ${value}`;
}

function highest(data: ReportPoint[]): number {
  return data.reduce((max, point) => Math.max(max, point.salesUgx, point.purchasesUgx), 0);
}

function ChartHeader({ title, high, label }: { title: string; high: number; label: string }): React.ReactElement {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <h2 className="text-lg font-bold text-ink-900">{title}</h2>
      <div className="text-right text-xs font-semibold text-ink-600">
        <span>{label}</span> <Money amount={high} size="table" />
      </div>
    </div>
  );
}

function tooltipFormatter(value: unknown, name: unknown): [string, string] {
  return [`UGX ${Number(value).toLocaleString("en-UG")}`, String(name)];
}

export default function ReportsCharts({ daily, weekly, monthly, labels }: ReportsChartsProps): React.ReactElement {
  return (
    <div className="grid gap-4">
      <section className="rounded-lg border border-line bg-surface-0 p-4 shadow-subtle">
        <ChartHeader title={labels.daily} high={highest(daily)} label={labels.highest} />
        <div className="mt-3 h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={daily} margin={{ top: 12, right: 12, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="#E2E8E5" vertical={false} />
              <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fill: "#4A5560", fontSize: 12 }} />
              <YAxis width={68} tickLine={false} axisLine={false} tick={{ fill: "#4A5560", fontSize: 12 }} tickFormatter={formatAxisUgx} />
              <Tooltip formatter={tooltipFormatter} contentStyle={{ borderColor: "#E2E8E5", borderRadius: 8 }} />
              <Line type="monotone" dataKey="salesUgx" name={labels.sales} stroke="#0E6B4A" strokeWidth={3} dot={false} activeDot={{ r: 5 }} />
              <Line type="monotone" dataKey="purchasesUgx" name={labels.purchases} stroke="#1F6FB2" strokeWidth={3} dot={false} activeDot={{ r: 5 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section className="rounded-lg border border-line bg-surface-0 p-4 shadow-subtle">
        <ChartHeader title={labels.weekly} high={highest(weekly)} label={labels.highest} />
        <div className="mt-3 h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={weekly} margin={{ top: 12, right: 12, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="#E2E8E5" vertical={false} />
              <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fill: "#4A5560", fontSize: 12 }} />
              <YAxis width={68} tickLine={false} axisLine={false} tick={{ fill: "#4A5560", fontSize: 12 }} tickFormatter={formatAxisUgx} />
              <Tooltip formatter={tooltipFormatter} contentStyle={{ borderColor: "#E2E8E5", borderRadius: 8 }} />
              <Bar dataKey="salesUgx" name={labels.sales} fill="#0E6B4A" radius={[4, 4, 0, 0]} />
              <Bar dataKey="purchasesUgx" name={labels.purchases} fill="#1F6FB2" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section className="rounded-lg border border-line bg-surface-0 p-4 shadow-subtle">
        <ChartHeader title={labels.monthly} high={highest(monthly)} label={labels.highest} />
        <div className="mt-3 h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={monthly} margin={{ top: 12, right: 12, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="#E2E8E5" vertical={false} />
              <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fill: "#4A5560", fontSize: 12 }} />
              <YAxis width={68} tickLine={false} axisLine={false} tick={{ fill: "#4A5560", fontSize: 12 }} tickFormatter={formatAxisUgx} />
              <Tooltip formatter={tooltipFormatter} contentStyle={{ borderColor: "#E2E8E5", borderRadius: 8 }} />
              <Bar dataKey="salesUgx" name={labels.sales} fill="#0E6B4A" radius={[4, 4, 0, 0]} />
              <Bar dataKey="purchasesUgx" name={labels.purchases} fill="#1F6FB2" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>
    </div>
  );
}
