import type React from "react";
import { lazy, Suspense, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, ChevronRight, CloudOff, PackageOpen, Pencil, ReceiptText, RotateCcw, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Money } from "@/components/Money";
import { Button } from "@/components/ui/button";
import {
  amendDraft,
  cancelDraft,
  confirmDraft,
  getTodaySalesSummary,
  listDrafts,
  listLowStockItems,
  listPurchases,
  listSales,
  type DraftRecord,
  type DraftState,
  type InventoryItem,
  type PurchaseRecord,
  type SaleRecord
} from "@/lib/api";
import { cn } from "@/lib/utils";

import type { SparklinePoint } from "./TodaySparkline";

const TodaySparkline = lazy(() => import("./TodaySparkline"));

const EAT_OFFSET_MS = 3 * 60 * 60 * 1000;
const PAGE_SIZE = 100;

type TodayData = {
  totalRevenue: number;
  saleCount: number;
  todaySales: SaleRecord[];
  todayPurchases: PurchaseRecord[];
  lowStock: InventoryItem[];
  drafts: DraftRecord[];
  draftTotal: number;
  sparkline: SparklinePoint[];
};

type DayRange = {
  from: string;
  to: string;
};

function getEatDateParts(date: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Kampala",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  return {
    year: Number(parts.find((part) => part.type === "year")?.value),
    month: Number(parts.find((part) => part.type === "month")?.value),
    day: Number(parts.find((part) => part.type === "day")?.value)
  };
}

function eatDayStartUtc(parts: { year: number; month: number; day: number }): Date {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day) - EAT_OFFSET_MS);
}

function getTodayEatRange(now = new Date()): DayRange {
  const parts = getEatDateParts(now);
  const start = eatDayStartUtc(parts);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
  return { from: start.toISOString(), to: end.toISOString() };
}

function getSevenDayEatRange(now = new Date()): DayRange {
  const todayParts = getEatDateParts(now);
  const todayStart = eatDayStartUtc(todayParts);
  const start = new Date(todayStart.getTime() - 6 * 24 * 60 * 60 * 1000);
  const end = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000 - 1);
  return { from: start.toISOString(), to: end.toISOString() };
}

function getEatDayKey(date: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Kampala",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(date));
}

function getSevenDayKeys(now = new Date()): { key: string; label: string }[] {
  const todayParts = getEatDateParts(now);
  const todayStart = eatDayStartUtc(todayParts);
  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(todayStart.getTime() - (6 - index) * 24 * 60 * 60 * 1000 + EAT_OFFSET_MS);
    const key = day.toISOString().slice(0, 10);
    const label = new Intl.DateTimeFormat("en-UG", { day: "2-digit", month: "short", timeZone: "Africa/Kampala" }).format(day);
    return { key, label };
  });
}

async function fetchAllSales(range: DayRange): Promise<SaleRecord[]> {
  const first = await listSales({ ...range, page: 1, perPage: PAGE_SIZE });
  const total = first.meta?.total ?? first.data.length;
  const sales = [...first.data];
  const pages = Math.ceil(total / PAGE_SIZE);
  for (let page = 2; page <= pages; page += 1) {
    const next = await listSales({ ...range, page, perPage: PAGE_SIZE });
    sales.push(...next.data);
  }
  return sales;
}

async function fetchAllPurchases(range: DayRange): Promise<PurchaseRecord[]> {
  const first = await listPurchases({ ...range, page: 1, perPage: PAGE_SIZE });
  const total = first.meta?.total ?? first.data.length;
  const purchases = [...first.data];
  const pages = Math.ceil(total / PAGE_SIZE);
  for (let page = 2; page <= pages; page += 1) {
    const next = await listPurchases({ ...range, page, perPage: PAGE_SIZE });
    purchases.push(...next.data);
  }
  return purchases;
}

function buildSparkline(sales: SaleRecord[]): SparklinePoint[] {
  const keys = getSevenDayKeys();
  const totals = new Map(keys.map(({ key }) => [key, 0]));
  sales.forEach((sale) => {
    const key = getEatDayKey(sale.createdAt);
    totals.set(key, (totals.get(key) ?? 0) + sale.totalPrice);
  });
  return keys.map(({ key, label }) => ({ label, salesUgx: totals.get(key) ?? 0 }));
}

async function fetchTodayData(): Promise<TodayData> {
  const todayRange = getTodayEatRange();
  const sevenDayRange = getSevenDayEatRange();
  const [summary, todaySales, todayPurchases, lowStock, draftsPage, sevenDaySales] = await Promise.all([
    getTodaySalesSummary(),
    fetchAllSales(todayRange),
    fetchAllPurchases(todayRange),
    listLowStockItems(),
    listDrafts({ page: 1, perPage: 20 }),
    fetchAllSales(sevenDayRange)
  ]);

  return {
    totalRevenue: summary.totalRevenue,
    saleCount: summary.saleCount,
    todaySales,
    todayPurchases,
    lowStock,
    drafts: draftsPage.data,
    draftTotal: draftsPage.meta?.total ?? draftsPage.data.length,
    sparkline: buildSparkline(sevenDaySales)
  };
}

function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));

  useEffect(() => {
    const goOnline = (): void => setOnline(true);
    const goOffline = (): void => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  return online;
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("en-UG", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Africa/Kampala"
  }).format(new Date(value));
}

function getSourceLabel(source: string, t: (key: string) => string): string {
  const known = ["whatsapp", "web", "mobile", "api", "pos", "inventory"];
  return known.includes(source) ? t(`today.source.${source}`) : source;
}

function ProvenanceBadge({ source, time }: { source: string; time: string }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <span className="inline-flex items-center rounded-md border border-line bg-surface-0 px-2 py-1 text-xs font-semibold text-ink-600">
      {t("today.provenance", { source: getSourceLabel(source, t), time: formatTime(time) })}
    </span>
  );
}

function SkeletonBlock({ className }: { className?: string }): React.ReactElement {
  return <div className={cn("animate-pulse rounded-lg bg-line", className)} />;
}

function TodaySkeleton(): React.ReactElement {
  return (
    <div className="space-y-5">
      <SkeletonBlock className="h-32" />
      <div className="grid gap-3 sm:grid-cols-2">
        <SkeletonBlock className="h-28" />
        <SkeletonBlock className="h-28" />
      </div>
      <SkeletonBlock className="h-44" />
      <SkeletonBlock className="h-44" />
      <SkeletonBlock className="h-52" />
    </div>
  );
}

function payloadSummary(draft: DraftRecord): string {
  const items = draft.payload.items;
  if (Array.isArray(items) && items.length > 0) {
    return items
      .map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return "";
        const line = item as Record<string, unknown>;
        return [line.qty, line.item].filter(Boolean).join(" ");
      })
      .filter(Boolean)
      .join(", ");
  }
  const item = draft.payload.item ?? draft.payload.expenseName;
  const qty = draft.payload.qty;
  return [qty, item].filter(Boolean).join(" ") || draft.action;
}

function canConfirm(state: DraftState): boolean {
  return state === "parsed" || state === "pending_clarification" || state === "confirmed";
}

function canAmend(state: DraftState): boolean {
  return state === "parsed" || state === "pending_clarification";
}

function canCancel(state: DraftState): boolean {
  return state === "parsed" || state === "pending_clarification" || state === "confirmed";
}

export function TodayPage(): React.ReactElement {
  const { t } = useTranslation();
  const online = useOnlineStatus();
  const [selectedDraft, setSelectedDraft] = useState<DraftRecord | null>(null);
  const todayQuery = useQuery({ queryKey: ["today"], queryFn: fetchTodayData });

  if (todayQuery.isLoading) return <TodaySkeleton />;

  if (todayQuery.isError || !todayQuery.data) {
    return (
      <section className="rounded-lg border border-line bg-surface-0 p-5 shadow-subtle">
        <h1 className="text-2xl font-bold text-ink-900">{t("today.errorTitle")}</h1>
        <p className="mt-2 text-sm font-medium text-ink-600">{t("today.errorBody")}</p>
        <Button className="mt-4" onClick={() => void todayQuery.refetch()}>
          <RotateCcw aria-hidden />
          {t("today.retry")}
        </Button>
      </section>
    );
  }

  const { data } = todayQuery;
  const cashOut = data.todayPurchases.reduce((sum, purchase) => sum + purchase.totalPrice, 0);
  const latestRecordTime = [...data.todaySales, ...data.todayPurchases]
    .map((record) => record.createdAt)
    .sort()
    .at(-1) ?? new Date().toISOString();
  const hasSales = data.saleCount > 0 || data.totalRevenue > 0;

  return (
    <div className="space-y-5">
      {!online ? (
        <div className="flex items-center gap-2 rounded-lg border border-warn-600 bg-surface-0 px-4 py-3 text-sm font-semibold text-warn-600">
          <CloudOff className="size-5" aria-hidden />
          {t("today.offline")}
        </div>
      ) : null}

      <section className="rounded-lg border border-line bg-surface-0 p-5 shadow-subtle">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-ink-600">{t("today.heroLabel")}</p>
            <Money amount={data.totalRevenue} size="hero" tone="positive" className="mt-3 block" />
          </div>
          <ProvenanceBadge source="api" time={latestRecordTime} />
        </div>
        <p className="mt-3 text-sm font-semibold text-ink-600">{t("today.saleCount", { count: data.saleCount })}</p>
        {!hasSales ? <p className="mt-4 rounded-lg bg-surface-1 p-4 text-sm font-semibold text-ink-600">{t("today.emptySales")}</p> : null}
      </section>

      <section className="grid gap-3 sm:grid-cols-2" aria-label={t("today.cashSection")}> 
        <MetricCard label={t("today.cashIn")} amount={data.totalRevenue} source="api" time={latestRecordTime} tone="positive" />
        <MetricCard label={t("today.cashOut")} amount={cashOut} source="api" time={latestRecordTime} />
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-bold text-ink-900">{t("today.lowStockTitle")}</h2>
          <span className="text-sm font-semibold text-ink-600">{t("today.itemCount", { count: data.lowStock.length })}</span>
        </div>
        {data.lowStock.length > 0 ? (
          <div className="grid gap-2">
            {data.lowStock.map((item) => (
              <div key={item.id} className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface-0 p-4 shadow-subtle">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="size-5 text-warn-600" aria-hidden />
                    <p className="truncate text-base font-bold text-ink-900">{item.name}</p>
                  </div>
                  <p className="mt-1 text-sm font-semibold text-ink-600">
                    {t("today.lowStockLine", { qty: item.qtyInStock, unit: item.unit, threshold: item.lowStockThreshold })}
                  </p>
                </div>
                <ProvenanceBadge source="inventory" time={item.createdAt} />
              </div>
            ))}
          </div>
        ) : (
          <div className="flex items-center gap-3 rounded-lg border border-line bg-surface-0 p-4 text-sm font-semibold text-ink-600 shadow-subtle">
            <PackageOpen className="size-5" aria-hidden />
            {t("today.noLowStock")}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-bold text-ink-900">{t("today.draftsTitle")}</h2>
          <span className="text-sm font-semibold text-ink-600">{t("today.draftCount", { count: data.draftTotal })}</span>
        </div>
        {data.drafts.length > 0 ? (
          <div className="grid gap-2">
            {data.drafts.map((draft) => (
              <button
                key={draft.id}
                className="touch-target flex w-full items-center justify-between gap-3 rounded-lg border border-line bg-surface-0 p-4 text-left shadow-subtle transition-colors duration-150 ease-gezi hover:bg-gezi-green-100"
                onClick={() => setSelectedDraft(draft)}
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <ReceiptText className="size-5 text-gezi-green-700" aria-hidden />
                    <p className="font-bold text-ink-900">{t(`today.action.${draft.action}`, { defaultValue: draft.action })}</p>
                    <StateBadge state={draft.state} />
                  </div>
                  <p className="mt-1 truncate text-sm font-semibold text-ink-600">{payloadSummary(draft)}</p>
                  {draft.clarificationQuestion ? <p className="mt-1 text-sm font-semibold text-warn-600">{draft.clarificationQuestion}</p> : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <ProvenanceBadge source="whatsapp" time={draft.createdAt} />
                  <ChevronRight className="size-5 text-ink-400" aria-hidden />
                </div>
              </button>
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-line bg-surface-0 p-4 text-sm font-semibold text-ink-600 shadow-subtle">
            {t("today.noDrafts")}
          </div>
        )}
      </section>

      <section className="rounded-lg border border-line bg-surface-0 p-5 shadow-subtle">
        <Suspense fallback={<SkeletonBlock className="h-52" />}>
          <TodaySparkline data={data.sparkline} title={t("today.sparklineTitle")} highestLabel={t("today.highestLabel")} />
        </Suspense>
      </section>

      {selectedDraft ? <DraftSheet draft={selectedDraft} onClose={() => setSelectedDraft(null)} /> : null}
    </div>
  );
}

function MetricCard({ label, amount, source, time, tone = "default" }: { label: string; amount: number; source: string; time: string; tone?: "default" | "positive" }): React.ReactElement {
  return (
    <div className="rounded-lg border border-line bg-surface-0 p-4 shadow-subtle">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-semibold text-ink-600">{label}</p>
        <ProvenanceBadge source={source} time={time} />
      </div>
      <Money amount={amount} size="card" tone={tone} className="mt-3 block" />
    </div>
  );
}

function StateBadge({ state }: { state: DraftState }): React.ReactElement {
  const { t } = useTranslation();
  return <span className="rounded-md bg-surface-1 px-2 py-1 text-xs font-bold text-ink-600">{t(`today.state.${state}`)}</span>;
}

function DraftSheet({ draft, onClose }: { draft: DraftRecord; onClose: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [payloadText, setPayloadText] = useState(() => JSON.stringify(draft.payload, null, 2));
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ["today"] });
    onClose();
  };

  const confirmMutation = useMutation({
    mutationFn: () => confirmDraft(draft.id, draft.state === "pending_clarification" && answer.trim() ? { answer } : {}),
    onSuccess: refresh,
    onError: (err) => setError(err instanceof Error ? err.message : t("today.draftActionError"))
  });
  const amendMutation = useMutation({
    mutationFn: () => {
      const parsed = JSON.parse(payloadText) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(t("today.invalidPayload"));
      return amendDraft(draft.id, { payload: parsed as Record<string, unknown>, clarificationQuestion: draft.clarificationQuestion });
    },
    onSuccess: refresh,
    onError: (err) => setError(err instanceof Error ? err.message : t("today.draftActionError"))
  });
  const cancelMutation = useMutation({
    mutationFn: () => cancelDraft(draft.id),
    onSuccess: refresh,
    onError: (err) => setError(err instanceof Error ? err.message : t("today.draftActionError"))
  });

  const busy = confirmMutation.isPending || amendMutation.isPending || cancelMutation.isPending;

  return (
    <div className="fixed inset-0 z-50 bg-ink-900/30" role="presentation">
      <aside className="fixed inset-y-0 right-0 flex w-full max-w-lg flex-col bg-surface-0 shadow-subtle" role="dialog" aria-modal="true" aria-label={t("today.draftSheetTitle")}>
        <div className="flex items-center justify-between border-b border-line p-4">
          <div>
            <h2 className="text-xl font-bold text-ink-900">{t("today.draftSheetTitle")}</h2>
            <div className="mt-2 flex items-center gap-2">
              <StateBadge state={draft.state} />
              <ProvenanceBadge source="whatsapp" time={draft.createdAt} />
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label={t("today.closeSheet")}>
            <X aria-hidden />
          </Button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          <div>
            <p className="text-sm font-semibold text-ink-600">{t("today.draftSummary")}</p>
            <p className="mt-1 text-lg font-bold text-ink-900">{payloadSummary(draft)}</p>
          </div>

          {draft.clarificationQuestion ? (
            <label className="block">
              <span className="text-sm font-semibold text-ink-600">{draft.clarificationQuestion}</span>
              <input
                className="mt-2 h-12 w-full rounded-md border border-line bg-surface-0 px-3 text-base font-semibold text-ink-900 outline-none focus:border-gezi-green-700"
                value={answer}
                onChange={(event) => setAnswer(event.target.value)}
              />
            </label>
          ) : null}

          {canAmend(draft.state) ? (
            <label className="block">
              <span className="text-sm font-semibold text-ink-600">{t("today.amendPayload")}</span>
              <textarea
                className="mt-2 min-h-48 w-full rounded-md border border-line bg-surface-0 p-3 font-mono text-sm text-ink-900 outline-none focus:border-gezi-green-700"
                value={payloadText}
                onChange={(event) => setPayloadText(event.target.value)}
                spellCheck={false}
              />
            </label>
          ) : (
            <div className="rounded-lg bg-surface-1 p-4 text-sm font-semibold text-ink-600">{t("today.immutableDraft")}</div>
          )}

          {error ? <div className="rounded-lg border border-danger-600 bg-surface-0 p-3 text-sm font-semibold text-danger-600">{error}</div> : null}
        </div>

        <div className="grid gap-2 border-t border-line p-4 sm:grid-cols-3">
          {canConfirm(draft.state) ? (
            <Button disabled={busy} onClick={() => confirmMutation.mutate()}>
              <Check aria-hidden />
              {t("today.confirmDraft")}
            </Button>
          ) : null}
          {canAmend(draft.state) ? (
            <Button variant="secondary" disabled={busy} onClick={() => amendMutation.mutate()}>
              <Pencil aria-hidden />
              {t("today.amendDraft")}
            </Button>
          ) : null}
          {canCancel(draft.state) ? (
            <Button variant="destructive" disabled={busy} onClick={() => cancelMutation.mutate()}>
              <X aria-hidden />
              {t("today.cancelDraft")}
            </Button>
          ) : null}
        </div>
      </aside>
    </div>
  );
}
