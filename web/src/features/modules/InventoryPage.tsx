import type React from "react";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ChevronRight, Search } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Money } from "@/components/Money";
import { Button } from "@/components/ui/button";
import { listInventory, listLowStockItems, type InventoryItem } from "@/lib/api";
import { cn } from "@/lib/utils";

import {
  DetailPanel,
  EmptyState,
  ErrorState,
  ExportButton,
  EXPORT_PAGE_SIZE,
  Field,
  formatDateTime,
  PAGE_SIZE,
  PageHeader,
  Pager,
  SkeletonRows,
  TableShell,
  downloadCsv,
  toCsv
} from "./ModuleUtils";

function typicalPrice(item: InventoryItem): number | null {
  return item.typicalSellPrice ?? item.typicalBuyPrice ?? null;
}

function inventoryCsvRows(rows: InventoryItem[]): Array<Record<string, string | number | null | undefined>> {
  return rows.map((item) => ({
    id: item.id,
    name: item.name,
    unit: item.unit,
    qtyInStock: item.qtyInStock,
    lowStockThreshold: item.lowStockThreshold,
    typicalPrice: typicalPrice(item),
    lastSold: item.lastSoldAt ?? null
  }));
}

export function InventoryPage(): React.ReactElement {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<InventoryItem | null>(null);
  const [searchText, setSearchText] = useState("");
  const [search, setSearch] = useState("");
  const [exporting, setExporting] = useState(false);

  const query = useQuery({ queryKey: ["inventory", page, search], queryFn: () => listInventory({ page, perPage: PAGE_SIZE, search: search || undefined, sortBy: "name", sortOrder: "asc" }) });
  const lowStockQuery = useQuery({ queryKey: ["inventory", "low-stock"], queryFn: listLowStockItems });

  const lowStockIds = useMemo(() => new Set((lowStockQuery.data ?? []).map((item) => item.id)), [lowStockQuery.data]);

  const applySearch = (): void => {
    setSearch(searchText.trim());
    setPage(1);
  };

  const exportRows = async (): Promise<void> => {
    setExporting(true);
    try {
      const first = await listInventory({ page: 1, perPage: EXPORT_PAGE_SIZE, search: search || undefined, sortBy: "name", sortOrder: "asc" });
      const totalRows = first.meta?.total ?? first.data.length;
      const rows = [...first.data];
      const pages = Math.ceil(totalRows / EXPORT_PAGE_SIZE);
      for (let exportPage = 2; exportPage <= pages; exportPage += 1) {
        rows.push(...(await listInventory({ page: exportPage, perPage: EXPORT_PAGE_SIZE, search: search || undefined, sortBy: "name", sortOrder: "asc" })).data);
      }
      downloadCsv("gezi-inventory.csv", toCsv(inventoryCsvRows(rows)));
    } finally {
      setExporting(false);
    }
  };

  if (query.isLoading) return <SkeletonRows />;
  if (query.isError || !query.data) return <ErrorState title={t("inventory.errorTitle")} body={t("common.errorBody")} onRetry={() => void query.refetch()} />;

  const visibleRows = query.data.data;
  const total = query.data.meta?.total ?? visibleRows.length;

  return (
    <div className="space-y-4">
      <PageHeader title={t("inventory.title")} total={t("inventory.total", { count: total })} endpoint="GET /api/v1/inventory?page=&perPage=&search= + GET /api/v1/inventory/low-stock">
        <div className="flex min-w-0 flex-1 items-center gap-2 sm:min-w-[320px]">
          <label className="relative min-w-0 flex-1">
            <span className="sr-only">{t("inventory.search")}</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 size-5 -translate-y-1/2 text-ink-400" aria-hidden />
            <input className="h-12 w-full rounded-md border border-line bg-surface-0 pl-10 pr-3 text-sm font-semibold text-ink-900" value={searchText} onChange={(event) => setSearchText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") applySearch(); }} placeholder={t("inventory.search")} />
          </label>
          <Button variant="secondary" onClick={applySearch}>{t("common.search")}</Button>
        </div>
        <ExportButton busy={exporting} onExport={() => void exportRows()} label={t("common.exportCsv")} />
      </PageHeader>

      {visibleRows.length === 0 ? <EmptyState message={t("inventory.empty")} /> : (
        <TableShell labelledBy="inventory-title">
          <table className="w-full min-w-[760px] border-collapse text-sm">
            <thead className="sticky top-0 z-10 bg-surface-1 text-left text-xs font-bold uppercase text-ink-600">
              <tr>
                <th className="px-4 py-3">{t("inventory.item")}</th>
                <th className="px-4 py-3 text-right">{t("inventory.qty")}</th>
                <th className="px-4 py-3 text-right">{t("inventory.threshold")}</th>
                <th className="px-4 py-3 text-right">{t("inventory.typicalPrice")}</th>
                <th className="px-4 py-3">{t("inventory.lastSold")}</th>
                <th className="px-4 py-3"><span className="sr-only">{t("common.open")}</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {visibleRows.map((item) => {
                const low = lowStockIds.has(item.id) || item.qtyInStock <= item.lowStockThreshold;
                const price = typicalPrice(item);
                return (
                  <tr key={item.id} className={cn("cursor-pointer hover:bg-gezi-green-100", low && "bg-warn-600/10")} onClick={() => setSelected(item)}>
                    <td className="max-w-[260px] px-4 py-3">
                      <div className="flex min-w-0 items-center gap-2">
                        {low ? <AlertTriangle className="size-5 shrink-0 text-warn-600" aria-hidden /> : null}
                        <span className="truncate font-bold text-ink-900">{item.name}</span>
                      </div>
                    </td>
                    <td className="money-nums px-4 py-3 text-right font-semibold text-ink-900">{item.qtyInStock} {item.unit}</td>
                    <td className="money-nums px-4 py-3 text-right font-semibold text-ink-600">{item.lowStockThreshold}</td>
                    <td className="px-4 py-3 text-right">{price == null ? <span className="text-ink-400">{t("common.blank")}</span> : <Money amount={price} />}</td>
                    <td className="px-4 py-3 font-semibold text-ink-600">{item.lastSoldAt ? formatDateTime(item.lastSoldAt) : t("common.blank")}</td>
                    <td className="px-4 py-3 text-right"><ChevronRight className="inline size-5 text-ink-400" aria-hidden /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableShell>
      )}

      <Pager page={page} total={total} perPage={PAGE_SIZE} onPage={setPage} />

      {selected ? (
        <DetailPanel title={selected.name} onClose={() => setSelected(null)}>
          <Field label={t("inventory.qty")} value={`${selected.qtyInStock} ${selected.unit}`} />
          <Field label={t("inventory.threshold")} value={selected.lowStockThreshold} />
          <Field label={t("inventory.typicalPrice")} value={typicalPrice(selected) == null ? t("common.blank") : <Money amount={typicalPrice(selected)!} size="card" />} money />
          <Field label={t("inventory.lastSold")} value={selected.lastSoldAt ? formatDateTime(selected.lastSoldAt) : t("common.blank")} />
          <Field label={t("common.lastUpdated")} value={formatDateTime(selected.updatedAt ?? selected.createdAt)} />
          <Button variant="secondary" onClick={() => setSelected(null)}>{t("common.close")}</Button>
        </DetailPanel>
      ) : null}
    </div>
  );
}
