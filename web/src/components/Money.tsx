import type React from "react";

import { cn } from "@/lib/utils";

type MoneySize = "hero" | "card" | "table";
type MoneyTone = "default" | "positive" | "negative";

type MoneyProps = {
  amount: number;
  size?: MoneySize;
  tone?: MoneyTone;
  className?: string;
};

const sizeClass: Record<MoneySize, string> = {
  hero: "text-[40px] font-bold leading-none",
  card: "text-2xl font-semibold leading-tight",
  table: "text-[15px] font-medium leading-5 text-right"
};

const toneClass: Record<MoneyTone, string> = {
  default: "text-ink-900",
  positive: "text-gezi-green-700",
  negative: "text-danger-600"
};

export function Money({ amount, size = "table", tone = "default", className }: MoneyProps): React.ReactElement {
  const isNegative = amount < 0;
  const absoluteAmount = Math.abs(amount);
  const formatted = new Intl.NumberFormat("en-UG", {
    maximumFractionDigits: 0,
    minimumFractionDigits: 0
  }).format(absoluteAmount);

  return (
    <span className={cn("money-nums inline-block", sizeClass[size], toneClass[isNegative ? "negative" : tone], className)}>
      {isNegative ? "−" : ""}
      UGX {formatted}
    </span>
  );
}
