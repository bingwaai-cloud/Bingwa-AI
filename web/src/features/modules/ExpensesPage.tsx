import type React from "react";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Money } from "@/components/Money";
import { Button } from "@/components/ui/button";
import { listExpenses, type ExpenseRecord } from "@/lib/api";

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
  rangeFromDays,
  rangeFromInputs,
  clampDateInputs,
  SkeletonRows,
  TableShell,
  downloadCsv,
  toCsv
} from "./ModuleUtils";

async function fetchAllExpenses(from: string, to: string): Promise<ExpenseRecord[]> {
  const first = await listExpenses({ from, to, page: 1, perPage: EXPORT_PAGE_SIZE });
  const total = first.meta?.total ?? first.data.length;
  const rows = [...first.data];
  const pages = Math.ceil(total / EXPORT_PAGE_SIZE);
  for (let page = 2; page <= pages; page += 1) {
    const next = await listExpenses({ from, to, page, perPage: EXPORT_PAGE_SIZE });
    rows.push(...next.data);
  }
  return rows;
}

function expenseCsvRows(rows: ExpenseRecord[]): Array<Record<string, string | number | null>> {
  return rows.map((expense) => ({
    id: expense.id,
    date: formatDateTime(expense.createdAt),
    name: expense.name,
    amountUgx: expense.amountUgx,
    frequency: expense.frequency,
    lastPaidAt: expense.lastPaidAt ? formatDateTime(expense.lastPaidAt) : null,
    nextDueAt: expense.nextDueAt ? formatDateTime(expense.nextDueAt) : null,
    notes: expense.notes
  }));
}

export function ExpensesPage(): React.ReactElement {
  const { t } = useTranslation();
  const initial = rangeFromDays(7);
  const [fromInput, setFromInput] = useState(initial.from.slice(0, 10));
  const [toInput, setToInput] = useState(initial.to.slice(0, 10));
  const [notice, setNotice] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<ExpenseRecord | null>(null);
  const [exporting, setExporting] = useState(false);
  const range = rangeFromInputs(fromInput, toInput);

  const query = useQuery({
    queryKey: ["expenses", range.from, range.to, page],
    queryFn: () => listExpenses({ ...range, page, perPage: PAGE_SIZE })
  });

  const applyRange = (nextFrom: string, nextTo: string): void => {
    const next = clampDateInputs(nextFrom, nextTo);
    setFromInput(next.fromInput);
    setToInput(next.toInput);
    setPage(1);
    setNotice(next.clamped ? t("expenses.rangeClamped") : null);
  };

  const exportRows = async (): Promise<void> => {
    setExporting(true);
    try {
      const rows = await fetchAllExpenses(range.from, range.to);
      downloadCsv(`gezi-expenses-${fromInput}-to-${toInput}.csv`, toCsv(expenseCsvRows(rows)));
    } finally {
      setExporting(false);
    }
  };

  if (query.isLoading) return <SkeletonRows />;
  if (query.isError || !query.data) return <ErrorState title={t("expenses.errorTitle")} body={t("common.errorBody")} onRetry={() => void query.refetch()} />;

  const rows = query.data.data;
  const total = query.data.meta?.total ?? rows.length;

  return (
    <div className="space-y-4">
      <PageHeader title={t("expenses.title")} total={t("expenses.total", { count: total })} endpoint="GET /api/v1/expenses">
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

      {rows.length === 0 ? <EmptyState message={t("expenses.empty")} /> : (
        <TableShell labelledBy="expenses-title">
          <table className="w-full min-w-[680px] border-collapse text-sm">
            <thead className="sticky top-0 z-10 bg-surface-1 text-left text-xs font-bold uppercase text-ink-600">
              <tr>
                <th className="px-4 py-3">{t("common.date")}</th>
                <th className="px-4 py-3">{t("expenses.name")}</th>
                <th className="px-4 py-3 text-right">{t("expenses.amount")}</th>
                <th className="px-4 py-3">{t("expenses.frequency")}</th>
                <th className="px-4 py-3">{t("expenses.lastPaid")}</th>
                <th className="px-4 py-3"><span className="sr-only">{t("common.open")}</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((expense) => (
                <tr key={expense.id} className="cursor-pointer hover:bg-gezi-green-100" onClick={() => setSelected(expense)}>
                  <td className="whitespace-nowrap px-4 py-3 font-semibold text-ink-900">{formatDate(expense.createdAt)}</td>
                  <td className="max-w-[240px] truncate px-4 py-3 font-bold text-ink-900">{expense.name}</td>
                  <td className="px-4 py-3 text-right"><Money amount={expense.amountUgx} /></td>
                  <td className="px-4 py-3 font-semibold text-ink-600">{expense.frequency}</td>
                  <td className="whitespace-nowrap px-4 py-3 font-semibold text-ink-600">{expense.lastPaidAt ? formatDate(expense.lastPaidAt) : t("common.blank")}</td>
                  <td className="px-4 py-3 text-right"><ChevronRight className="inline size-5 text-ink-400" aria-hidden /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableShell>
      )}

      <Pager page={page} total={total} perPage={PAGE_SIZE} onPage={setPage} />

      {selected ? (
        <DetailPanel title={t("expenses.detailTitle")} onClose={() => setSelected(null)}>
          <Field label={t("common.date")} value={formatDateTime(selected.createdAt)} />
          <Field label={t("expenses.amount")} value={<Money amount={selected.amountUgx} size="card" />} money />
          <Field label={t("expenses.frequency")} value={selected.frequency} />
          <Field label={t("expenses.lastPaid")} value={selected.lastPaidAt ? formatDateTime(selected.lastPaidAt) : t("common.blank")} />
          <Field label={t("expenses.nextDue")} value={selected.nextDueAt ? formatDateTime(selected.nextDueAt) : t("common.blank")} />
          {selected.notes ? <Field label={t("expenses.notes")} value={selected.notes} /> : null}
          <Button variant="secondary" onClick={() => setSelected(null)}>{t("common.close")}</Button>
        </DetailPanel>
      ) : null}
    </div>
  );
}
