import type React from "react";
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { Money } from "@/components/Money";

export type SparklinePoint = {
  label: string;
  salesUgx: number;
};

type TodaySparklineProps = {
  data: SparklinePoint[];
  title: string;
  highestLabel: string;
};

function formatAxisUgx(value: number): string {
  if (value >= 1_000_000) return `UGX ${Math.round(value / 1_000_000)}m`;
  if (value >= 1_000) return `UGX ${Math.round(value / 1_000)}k`;
  return `UGX ${value}`;
}

export default function TodaySparkline({ data, title, highestLabel }: TodaySparklineProps): React.ReactElement {
  const highest = data.reduce((max, point) => Math.max(max, point.salesUgx), 0);

  return (
    <div className="space-y-3" aria-label={title}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-bold text-ink-900">{title}</h2>
        <div className="text-right text-xs font-semibold text-ink-600">
          <span>{highestLabel}</span> <Money amount={highest} size="table" />
        </div>
      </div>
      <div className="h-44 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 12, right: 8, bottom: 0, left: 0 }}>
            <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fill: "#4A5560", fontSize: 12 }} />
            <YAxis
              width={64}
              tickLine={false}
              axisLine={false}
              tick={{ fill: "#4A5560", fontSize: 12 }}
              tickFormatter={formatAxisUgx}
            />
            <Tooltip
              formatter={(value) => [`UGX ${Number(value).toLocaleString("en-UG")}`, title]}
              labelClassName="text-ink-900"
              contentStyle={{ borderColor: "#E2E8E5", borderRadius: 8, boxShadow: "0 8px 24px rgba(16, 20, 24, 0.08)" }}
            />
            <Line type="monotone" dataKey="salesUgx" stroke="#0E6B4A" strokeWidth={3} dot={false} activeDot={{ r: 5 }} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
