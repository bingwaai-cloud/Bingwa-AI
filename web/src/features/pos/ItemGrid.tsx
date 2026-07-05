import type React from "react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Money } from "@/components/Money";
import { NumericKeypad } from "./NumericKeypad";
import type { InventoryItem } from "@/lib/api";

type CartItemInput = {
  itemId?: string;
  itemName: string;
  qty: number;
  unit: string;
  unitPrice: number;
  totalPrice: number;
};

type ItemGridProps = {
  items: InventoryItem[];
  onAddToCart: (item: CartItemInput) => void;
  loading: boolean;
};

function rankByRecency(items: InventoryItem[]): InventoryItem[] {
  // Rank: items with lastSoldAt date first (most recent), then alphabetically
  return [...items].sort((a, b) => {
    if (a.lastSoldAt && b.lastSoldAt) {
      return new Date(b.lastSoldAt).getTime() - new Date(a.lastSoldAt).getTime();
    }
    if (a.lastSoldAt) return -1;
    if (b.lastSoldAt) return 1;
    return a.name.localeCompare(b.name);
  }).slice(0, 20);
}

export function ItemGrid({ items, onAddToCart, loading }: ItemGridProps): React.ReactElement {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [editingItem, setEditingItem] = useState<InventoryItem | null>(null);
  const [priceValue, setPriceValue] = useState("0");

  const ranked = useMemo(() => rankByRecency(items), [items]);

  const filtered = useMemo(() => {
    if (!search.trim()) return ranked;
    const query = search.toLowerCase();
    return items
      .filter((item) => item.name.toLowerCase().includes(query))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 20);
  }, [items, ranked, search]);

  const handleTap = (item: InventoryItem) => {
    const price = item.typicalSellPrice ?? 0;
    onAddToCart({
      itemId: item.id,
      itemName: item.name,
      qty: 1,
      unit: item.unit || "pc",
      unitPrice: price,
      totalPrice: price
    });
  };

  const handlePriceEdit = (item: InventoryItem, e: React.MouseEvent) => {
    e.stopPropagation();
    const price = item.typicalSellPrice ?? 0;
    setPriceValue(String(price));
    setEditingItem(item);
  };

  const handlePriceConfirm = () => {
    if (!editingItem) return;
    const price = parseInt(priceValue, 10);
    if (isNaN(price) || price <= 0) return;
    onAddToCart({
      itemId: editingItem.id,
      itemName: editingItem.name,
      qty: 1,
      unit: editingItem.unit || "pc",
      unitPrice: price,
      totalPrice: price
    });
    setEditingItem(null);
  };

  if (loading) {
    return (
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-24 animate-pulse rounded-lg bg-line" />
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
        <p className="text-sm font-medium text-ink-600">{t("pos.emptyInventory")}</p>
        <p className="text-xs text-ink-400">{t("pos.emptyInventoryBody")}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="relative">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("pos.search")}
          className="w-full rounded-lg border border-line bg-surface-0 py-2.5 pl-9 pr-3 text-sm text-ink-900 placeholder:text-ink-400 focus:border-gezi-green-700 focus:outline-none"
        />
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {filtered.map((item) => (
          <button
            key={item.id}
            onClick={() => handleTap(item)}
            className="relative flex flex-col items-center justify-center rounded-lg border border-line bg-surface-0 p-3 text-center transition-colors hover:bg-gezi-green-100/50 active:scale-95"
            style={{ minHeight: "96px" }}
          >
            <span className="text-sm font-medium text-ink-900 truncate max-w-full">{item.name}</span>
            <span className="mt-1 text-xs tabular-nums text-ink-600">
              {item.typicalSellPrice ? (
                <Money amount={item.typicalSellPrice} size="table" />
              ) : (
                <span className="text-ink-400">{t("common.blank")}</span>
              )}
            </span>
            <span
            role="button"
            tabIndex={0}
            onClick={(e) => handlePriceEdit(item, e)}
            onKeyDown={(e) => { if (e.key === "Enter") handlePriceEdit(item, e as unknown as React.MouseEvent); }}
            className="mt-1 text-[10px] text-ink-400 underline hover:text-gezi-green-700 cursor-pointer"
            aria-label={t("pos.editPrice")}
          >
            {t("pos.editPrice")}
          </span>
            {item.qtyInStock <= item.lowStockThreshold && item.qtyInStock > 0 && (
              <span className="absolute right-1 top-1 rounded bg-warn-600/15 px-1 py-0.5 text-[10px] font-medium text-warn-600">
                {item.qtyInStock}
              </span>
            )}
            {item.qtyInStock === 0 && (
              <span className="absolute right-1 top-1 rounded bg-danger-600/15 px-1 py-0.5 text-[10px] font-medium text-danger-600">
                0
              </span>
            )}
          </button>
        ))}
      </div>

      {editingItem && (
        <NumericKeypad
          value={priceValue}
          onChange={setPriceValue}
          onClose={() => setEditingItem(null)}
          title={`${editingItem.name} — ${t("pos.editPrice")}`}
        />
      )}
    </div>
  );
}