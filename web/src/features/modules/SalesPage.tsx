import type React from "react";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Money } from "@/components/Money";
import { Button } from "@/components/ui/button";
import { listSales, type SaleRecord } from "@/lib/api";

import {
  DetailPanel,
  EmptyState,
  ErrorState,
  ExportButton,
  EXPORT_PAGE_SIZE,
  Field,
  formatDate,
  formatDateTime,
  getDateInputValue,
  PAGE_SIZE,
  PageHeader,
  Pager,
  ProvenanceBadge,
  rangeFromDays,
  rangeFromInputs,
  clampDateInputs,
  SkeletonRows,
  TableShell,
  downloadCsv,
  toCsv
} from "./ModuleUtils";

async function fetchAllSales(from: string, to: string): Promise<SaleRecord[]> {
  const first = await listSales({ from, to, page: 1, perPage: EXPORT_PAGE_SIZE });
  const total = first.meta?.total ?? first.data.length;
  const rows = [...first.data];
  const pages = Math.ceil(total / EXPORT_PAGE_SIZE);
  for (let page = 2; page <= pages; page += 1) {
    const next = await listSales({ from, to, page, perPage: EXPORT_PAGE_SIZE });
    rows.push(...next.data);
  }
  return rows;
}

function saleCsvRows(rows: SaleRecord[]): Array<Record<string, string | number>> {
  return rows.map((sale) => ({
    id: sale.id,
    date: formatDateTime(sale.createdAt),
    item: sale.itemName,
    items: sale.lines.map((line) => `${line.qty} ${line.unit} ${line.itemName}`).join("; "),
    qty: sale.qty,
    unitPrice: sale.unitPrice,
    totalPrice: sale.totalPrice,
    source: sale.source
  }));
}

export function SalesPage(): React.ReactElement {
  const { t } = useTranslation();
  const initial = rangeFromDays(7);
  const [fromInput, setFromInput] = useState(initial.from.slice(0, 10));
  const [toInput, setToInput] = useState(initial.to.slice(0, 10));
  const [notice, setNotice] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<SaleRecord | null>(null);
  const [exporting, setExporting] = useState(false);
  const range = rangeFromInputs(fromInput, toInput);

  const query = useQuery({
    queryKey: ["sales", range.from, range.to, page],
    queryFn: () => listSales({ ...range, page, perPage: PAGE_SIZE })
  });

  const applyRange = (nextFrom: string, nextTo: string): void => {
    const next = clampDateInputs(nextFrom, nextTo);
    setFromInput(next.fromInput);
    setToInput(next.toInput);
    setPage(1);
    setNotice(next.clamped ? t("sales.rangeClamped") : null);
  };

  const exportRows = async (): Promise<void> => {
    setExporting(true);
    try {
      const rows = await fetchAllSales(range.from, range.to);
      downloadCsv(`gezi-sales-${fromInput}-to-${toInput}.csv`, toCsv(saleCsvRows(rows)));
    } finally {
      setExporting(false);
    }
  };

  if (query.isLoading) return <SkeletonRows />;
  if (query.isError || !query.data) return <ErrorState title={t("sales.errorTitle")} body={t("common.errorBody")} onRetry={() => void query.refetch()} />;

  const rows = query.data.data;
  const total = query.data.meta?.total ?? rows.length;

  return (
    <div className="space-y-4">
      <PageHeader title={t("sales.title")} total={t("sales.total", { count: total })} endpoint="GET /api/v1/sales">
        <label className="grid gap-1 text-xs font-bold text-ink-600">
          {t("common.from")}
          <input className="h-12 rounded-md border border-line bg-surface-0 px-3 text-sm font-semibold text-ink-900" type="date" value={fromInput} onChange={(event) => applyRange(event.target.value, toInput)} />
        </label>
        <label className="grid gap-1 text-xs font-bold text-ink-600">
          {t("common.to")}
          <input className="h-12 rounded-md border border-line bg-surface-0 px-3 text-sm font-semibold text-ink-900" type="date" max={getDateInputValue(new Date())} value={toInput} onChange={(event) => applyRange(fromInput, event.target.value)} />
        </label>
        <ExportButton busy={exporting} onExport={() => void exportRows()} label={t("common.exportCsv")} />
      </PageHeader>

      {notice ? <p className="rounded-lg border border-warn-600 bg-surface-0 p-3 text-sm font-semibold text-warn-600">{notice}</p> : null}

      {rows.length === 0 ? <EmptyState message={t("sales.empty")} /> : (
        <TableShell labelledBy="sales-title">
          <table className="w-full min-w-[760px] border-collapse text-sm">
            <thead className="sticky top-0 z-10 bg-surface-1 text-left text-xs font-bold uppercase text-ink-600">
              <tr>
                <th className="px-4 py-3">{t("common.date")}</th>
                <th className="px-4 py-3">{t("sales.item")}</th>
                <th className="px-4 py-3 text-right">{t("sales.qty")}</th>
                <th className="px-4 py-3 text-right">{t("sales.unitPrice")}</th>
                <th className="px-4 py-3 text-right">{t("sales.totalPrice")}</th>
                <th className="px-4 py-3">{t("common.provenanceLabel")}</th>
                <th className="px-4 py-3"><span className="sr-only">{t("common.open")}</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((sale) => (
                <tr key={sale.id} className="cursor-pointer hover:bg-gezi-green-100" onClick={() => setSelected(sale)}>
                  <td className="whitespace-nowrap px-4 py-3 font-semibold text-ink-900">{formatDate(sale.createdAt)}</td>
                  <td className="max-w-[220px] truncate px-4 py-3 font-bold text-ink-900">{sale.itemName}</td>
                  <td className="money-nums px-4 py-3 text-right font-semibold text-ink-900">{sale.qty}</td>
                  <td className="px-4 py-3 text-right"><Money amount={sale.unitPrice} /></td>
                  <td className="px-4 py-3 text-right"><Money amount={sale.totalPrice} /></td>
                  <td className="px-4 py-3"><ProvenanceBadge source={sale.source} time={sale.createdAt} /></td>
                  <td className="px-4 py-3 text-right"><ChevronRight className="inline size-5 text-ink-400" aria-hidden /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableShell>
      )}

      <Pager page={page} total={total} perPage={PAGE_SIZE} onPage={setPage} />

      {selected ? (
        <DetailPanel title={t("sales.detailTitle")} onClose={() => setSelected(null)}>
          <Field label={t("common.date")} value={formatDateTime(selected.createdAt)} />
          <Field label={t("sales.totalPrice")} value={<Money amount={selected.totalPrice} size="card" />} money />
          <Field label={t("common.provenanceLabel")} value={<ProvenanceBadge source={selected.source} time={selected.createdAt} />} />
          <div className="rounded-lg border border-line">
            <div className="border-b border-line bg-surface-1 p-3 text-sm font-bold text-ink-900">{t("sales.lines")}</div>
            <div className="divide-y divide-line">
              {selected.lines.map((line) => (
                <div key={line.id} className="grid grid-cols-[1fr_auto] gap-3 p-3">
                  <div className="min-w-0">
                    <p className="truncate font-bold text-ink-900">{line.itemName}</p>
                    <p className="text-sm font-semibold text-ink-600">{line.qty} {line.unit}</p>
                  </div>
                  <Money amount={line.totalPrice} />
                </div>
              ))}
            </div>
          </div>
          <Button variant="secondary" onClick={() => setSelected(null)}>{t("common.close")}</Button>
        </DetailPanel>
      ) : null}
    </div>
  );
}
