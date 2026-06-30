import type React from "react";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Search } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Money } from "@/components/Money";
import { Button } from "@/components/ui/button";
import { listCustomerPurchases, listCustomers, type CustomerRecord, type SaleRecord } from "@/lib/api";

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

async function fetchAllCustomers(search: string): Promise<CustomerRecord[]> {
  const first = await listCustomers({ search: search || undefined, page: 1, perPage: EXPORT_PAGE_SIZE });
  const total = first.meta?.total ?? first.data.length;
  const rows = [...first.data];
  const pages = Math.ceil(total / EXPORT_PAGE_SIZE);
  for (let page = 2; page <= pages; page += 1) {
    const next = await listCustomers({ search: search || undefined, page, perPage: EXPORT_PAGE_SIZE });
    rows.push(...next.data);
  }
  return rows;
}

function customerLabel(customer: CustomerRecord): string {
  return customer.name ?? customer.phone ?? "Customer";
}

function customerCsvRows(rows: CustomerRecord[]): Array<Record<string, string | number | null>> {
  return rows.map((customer) => ({
    id: customer.id,
    name: customer.name,
    phone: customer.phone,
    visitCount: customer.visitCount,
    totalPurchases: customer.totalPurchases,
    lastVisitedAt: customer.lastVisitedAt ? formatDateTime(customer.lastVisitedAt) : null,
    optedInMarketing: String(customer.optedInMarketing)
  }));
}

export function CustomersPage(): React.ReactElement {
  const { t } = useTranslation();
  const [searchText, setSearchText] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<CustomerRecord | null>(null);
  const [exporting, setExporting] = useState(false);

  const query = useQuery({
    queryKey: ["customers", search, page],
    queryFn: () => listCustomers({ search: search || undefined, page, perPage: PAGE_SIZE })
  });

  const applySearch = (): void => {
    setSearch(searchText.trim());
    setPage(1);
  };

  const exportRows = async (): Promise<void> => {
    setExporting(true);
    try {
      const rows = await fetchAllCustomers(search);
      downloadCsv("gezi-customers.csv", toCsv(customerCsvRows(rows)));
    } finally {
      setExporting(false);
    }
  };

  if (query.isLoading) return <SkeletonRows />;
  if (query.isError || !query.data) return <ErrorState title={t("customers.errorTitle")} body={t("common.errorBody")} onRetry={() => void query.refetch()} />;

  const rows = query.data.data;
  const total = query.data.meta?.total ?? rows.length;

  return (
    <div className="space-y-4">
      <PageHeader title={t("customers.title")} total={t("customers.total", { count: total })} endpoint="GET /api/v1/customers">
        <div className="flex min-w-0 flex-1 items-center gap-2 sm:min-w-[320px]">
          <label className="relative min-w-0 flex-1">
            <span className="sr-only">{t("customers.search")}</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 size-5 -translate-y-1/2 text-ink-400" aria-hidden />
            <input className="h-12 w-full rounded-md border border-line bg-surface-0 pl-10 pr-3 text-sm font-semibold text-ink-900" value={searchText} onChange={(event) => setSearchText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") applySearch(); }} placeholder={t("customers.search")} />
          </label>
          <Button variant="secondary" onClick={applySearch}>{t("common.search")}</Button>
        </div>
        <ExportButton busy={exporting} onExport={() => void exportRows()} label={t("common.exportCsv")} />
      </PageHeader>


      {rows.length === 0 ? <EmptyState message={t("customers.empty")} /> : (
        <TableShell labelledBy="customers-title">
          <table className="w-full min-w-[760px] border-collapse text-sm">
            <thead className="sticky top-0 z-10 bg-surface-1 text-left text-xs font-bold uppercase text-ink-600">
              <tr>
                <th className="px-4 py-3">{t("customers.customer")}</th>
                <th className="px-4 py-3">{t("customers.phone")}</th>
                <th className="px-4 py-3 text-right">{t("customers.visits")}</th>
                <th className="px-4 py-3 text-right">{t("customers.totalPurchases")}</th>
                <th className="px-4 py-3">{t("customers.lastVisit")}</th>
                <th className="px-4 py-3"><span className="sr-only">{t("common.open")}</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((customer) => (
                <tr key={customer.id} className="cursor-pointer hover:bg-gezi-green-100" onClick={() => setSelected(customer)}>
                  <td className="max-w-[240px] truncate px-4 py-3 font-bold text-ink-900">{customerLabel(customer)}</td>
                  <td className="whitespace-nowrap px-4 py-3 font-semibold text-ink-600">{customer.phone ?? t("common.blank")}</td>
                  <td className="money-nums px-4 py-3 text-right font-semibold text-ink-900">{customer.visitCount}</td>
                  <td className="px-4 py-3 text-right"><Money amount={customer.totalPurchases} /></td>
                  <td className="whitespace-nowrap px-4 py-3 font-semibold text-ink-600">{customer.lastVisitedAt ? formatDateTime(customer.lastVisitedAt) : t("common.blank")}</td>
                  <td className="px-4 py-3 text-right"><ChevronRight className="inline size-5 text-ink-400" aria-hidden /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableShell>
      )}

      <Pager page={page} total={total} perPage={PAGE_SIZE} onPage={setPage} />

      {selected ? (
        <DetailPanel title={customerLabel(selected)} onClose={() => setSelected(null)}>
          <Field label={t("customers.phone")} value={selected.phone ?? t("common.blank")} />
          <Field label={t("customers.totalPurchases")} value={<Money amount={selected.totalPurchases} size="card" />} money />
          <Field label={t("customers.visits")} value={selected.visitCount} />
          <Field label={t("customers.lastVisit")} value={selected.lastVisitedAt ? formatDateTime(selected.lastVisitedAt) : t("common.blank")} />
          <CustomerPurchaseHistory customer={selected} />
          <Button variant="secondary" onClick={() => setSelected(null)}>{t("common.close")}</Button>
        </DetailPanel>
      ) : null}
    </div>
  );
}


function CustomerPurchaseHistory({ customer }: { customer: CustomerRecord }): React.ReactElement {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: ["customers", customer.id, "purchases"],
    queryFn: () => listCustomerPurchases(customer.id, { page: 1, perPage: 5 })
  });

  if (query.isLoading) return <SkeletonRows />;
  if (query.isError || !query.data) return <EmptyState message={t("customers.purchaseHistoryError")} />;

  const rows: SaleRecord[] = query.data.data;
  if (rows.length === 0) return <EmptyState message={t("customers.noPurchaseHistory")} />;

  return (
    <div className="rounded-lg border border-line">
      <div className="border-b border-line bg-surface-1 p-3 text-sm font-bold text-ink-900">{t("customers.purchaseHistory")}</div>
      <div className="divide-y divide-line">
        {rows.map((sale) => (
          <div key={sale.id} className="grid grid-cols-[1fr_auto] gap-3 p-3">
            <div className="min-w-0">
              <p className="truncate font-bold text-ink-900">{sale.itemName}</p>
              <p className="text-sm font-semibold text-ink-600">{formatDateTime(sale.createdAt)}</p>
            </div>
            <Money amount={sale.totalPrice} />
          </div>
        ))}
      </div>
    </div>
  );
}
