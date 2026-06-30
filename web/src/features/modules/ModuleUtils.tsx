import type React from "react";
import { Download, RotateCcw, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const PAGE_SIZE = 20;
export const EXPORT_PAGE_SIZE = 100;
export const MAX_RANGE_DAYS = 90;

export type DateRange = {
  from: string;
  to: string;
};

const EAT_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function getDateInputValue(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Kampala" }).format(date);
}

export function rangeFromDays(days: number, now = new Date()): DateRange {
  const today = getDateInputValue(now);
  const to = new Date(`${today}T20:59:59.999Z`);
  const from = new Date(to.getTime() - (days - 1) * DAY_MS);
  from.setUTCHours(21, 0, 0, 0);
  return { from: from.toISOString(), to: to.toISOString() };
}

export function rangeFromInputs(fromInput: string, toInput: string): DateRange {
  const from = new Date(`${fromInput}T00:00:00.000+03:00`);
  const to = new Date(`${toInput}T23:59:59.999+03:00`);
  return { from: from.toISOString(), to: to.toISOString() };
}

export function clampDateInputs(fromInput: string, toInput: string): { fromInput: string; toInput: string; clamped: boolean } {
  const from = new Date(`${fromInput}T00:00:00.000+03:00`);
  const to = new Date(`${toInput}T00:00:00.000+03:00`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
    const fallback = rangeFromDays(7);
    return { fromInput: fallback.from.slice(0, 10), toInput: fallback.to.slice(0, 10), clamped: true };
  }
  const maxFrom = new Date(to.getTime() - (MAX_RANGE_DAYS - 1) * DAY_MS);
  if (from < maxFrom) return { fromInput: getDateInputValue(new Date(maxFrom.getTime() + EAT_OFFSET_MS)), toInput, clamped: true };
  return { fromInput, toInput, clamped: false };
}

export function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("en-UG", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Africa/Kampala"
  }).format(new Date(value));
}

export function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-UG", { day: "2-digit", month: "short", year: "numeric", timeZone: "Africa/Kampala" }).format(new Date(value));
}

export function formatUgx(amount: number): string {
  return `UGX ${new Intl.NumberFormat("en-UG", { maximumFractionDigits: 0 }).format(amount)}`;
}

export function sourceLabel(source: string, t: (key: string, options?: { defaultValue?: string }) => string): string {
  return t(`common.source.${source}`, { defaultValue: source });
}

export function ProvenanceBadge({ source, time }: { source: string; time: string }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <span className="inline-flex max-w-full items-center rounded-md border border-line bg-surface-0 px-2 py-1 text-xs font-semibold text-ink-600">
      <span className="truncate">{t("common.provenance", { source: sourceLabel(source, t), time: formatDateTime(time).slice(-5) })}</span>
    </span>
  );
}

export function EndpointPill({ children }: { children: React.ReactNode }): React.ReactElement {
  return <span className="rounded-md bg-surface-1 px-2 py-1 font-mono text-xs font-semibold text-ink-600">{children}</span>;
}

export function PageHeader({ title, total, endpoint, children }: { title: string; total?: string; endpoint: string; children?: React.ReactNode }): React.ReactElement {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold text-ink-900">{title}</h1>
        {total ? <p className="mt-1 text-sm font-semibold text-ink-600">{total}</p> : null}
        <div className="mt-2"><EndpointPill>{endpoint}</EndpointPill></div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

export function TableShell({ children, labelledBy }: { children: React.ReactNode; labelledBy: string }): React.ReactElement {
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface-0 shadow-subtle">
      <div className="max-h-[68vh] overflow-auto" aria-labelledby={labelledBy}>{children}</div>
    </div>
  );
}

export function Pager({ page, total, perPage, onPage }: { page: number; total: number; perPage: number; onPage: (page: number) => void }): React.ReactElement {
  const { t } = useTranslation();
  const pages = Math.max(1, Math.ceil(total / perPage));
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm font-semibold text-ink-600">{t("common.pageStatus", { page, pages, total })}</p>
      <div className="grid grid-cols-2 gap-2 sm:flex">
        <Button variant="secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>{t("common.previous")}</Button>
        <Button variant="secondary" disabled={page >= pages} onClick={() => onPage(page + 1)}>{t("common.next")}</Button>
      </div>
    </div>
  );
}

export function EmptyState({ message }: { message: string }): React.ReactElement {
  return <div className="rounded-lg border border-line bg-surface-0 p-5 text-sm font-semibold text-ink-600 shadow-subtle">{message}</div>;
}

export function ErrorState({ title, body, onRetry }: { title: string; body: string; onRetry: () => void }): React.ReactElement {
  return (
    <section className="rounded-lg border border-line bg-surface-0 p-5 shadow-subtle">
      <h1 className="text-2xl font-bold text-ink-900">{title}</h1>
      <p className="mt-2 text-sm font-medium text-ink-600">{body}</p>
      <Button className="mt-4" onClick={onRetry}><RotateCcw aria-hidden />Try again</Button>
    </section>
  );
}

export function SkeletonRows(): React.ReactElement {
  return <div className="space-y-3">{Array.from({ length: 5 }, (_, i) => <div key={i} className="h-14 animate-pulse rounded-lg bg-line" />)}</div>;
}

export function DetailPanel({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="fixed inset-0 z-50 bg-ink-900/30" role="presentation">
      <aside className="fixed inset-y-0 right-0 flex w-full max-w-xl flex-col bg-surface-0 shadow-subtle" role="dialog" aria-modal="true" aria-label={title}>
        <div className="flex items-center justify-between border-b border-line p-4">
          <h2 className="min-w-0 text-xl font-bold text-ink-900">{title}</h2>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close"><X aria-hidden /></Button>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto p-4">{children}</div>
      </aside>
    </div>
  );
}

export function Field({ label, value, money = false }: { label: string; value: React.ReactNode; money?: boolean }): React.ReactElement {
  return (
    <div className="rounded-lg bg-surface-1 p-3">
      <p className="text-xs font-bold uppercase text-ink-600">{label}</p>
      <div className={cn("mt-1 text-base font-bold text-ink-900", money && "money-nums text-right")}>{value}</div>
    </div>
  );
}

export function toCsv(rows: Array<Record<string, string | number | null | undefined>>): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]!);
  const escape = (value: string | number | null | undefined): string => {
    const raw = value == null ? "" : String(value);
    return /[",\n]/.test(raw) ? `"${raw.replaceAll('"', '""')}"` : raw;
  };
  return [headers.join(","), ...rows.map((row) => headers.map((header) => escape(row[header])).join(","))].join("\n");
}

export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function ExportButton({ busy, onExport, label }: { busy: boolean; onExport: () => void; label: string }): React.ReactElement {
  return <Button variant="secondary" disabled={busy} onClick={onExport}><Download aria-hidden />{label}</Button>;
}
