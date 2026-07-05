import type React from "react";
import { useTranslation } from "react-i18next";
import { Minus, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Money } from "@/components/Money";
import type { CartItem } from "./useOfflineQueue";

type CartProps = {
  items: CartItem[];
  onUpdateQty: (index: number, delta: number) => void;
  onUpdatePrice: (index: number, price: number) => void;
  onRemove: (index: number) => void;
  onCharge: () => void;
  disabled?: boolean;
};

export function Cart({ items, onUpdateQty, onUpdatePrice, onRemove, onCharge, disabled }: CartProps): React.ReactElement {
  const { t } = useTranslation();

  const total = items.reduce((sum, item) => sum + item.totalPrice, 0);

  return (
    <div className="flex h-full flex-col">
      <h2 className="mb-3 text-sm font-semibold text-ink-900">{t("pos.cartTitle")}</h2>

      {items.length === 0 ? (
        <p className="flex-1 text-center text-sm text-ink-400 py-8">{t("pos.noItems")}</p>
      ) : (
        <div className="flex-1 overflow-y-auto space-y-2 mb-3">
          {items.map((item, i) => (
            <div
              key={`${item.itemName}-${i}`}
              className="flex items-center gap-2 rounded-lg border border-line bg-surface-0 p-2"
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-ink-900 truncate">{item.itemName}</p>
                <div className="mt-1 flex items-center gap-2">
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => onUpdateQty(i, -1)}
                      className="flex h-7 w-7 items-center justify-center rounded border border-line text-ink-600 hover:bg-surface-1"
                      aria-label={t("common.close")}
                    >
                      <Minus size={12} />
                    </button>
                    <span className="w-6 text-center text-sm tabular-nums font-medium">{item.qty}</span>
                    <button
                      onClick={() => onUpdateQty(i, 1)}
                      className="flex h-7 w-7 items-center justify-center rounded border border-line text-ink-600 hover:bg-surface-1"
                      aria-label={t("pos.qty")}
                    >
                      <Plus size={12} />
                    </button>
                  </div>
                  <span className="text-sm tabular-nums text-ink-600">
                    <Money amount={item.unitPrice} size="table" />
                  </span>
                </div>
              </div>
              <div className="text-right">
                <Money amount={item.totalPrice} size="table" className="text-sm" />
                <button
                  onClick={() => onRemove(i)}
                  className="ml-1 flex h-7 w-7 items-center justify-center rounded text-ink-400 hover:bg-danger-600/10 hover:text-danger-600"
                  aria-label={t("pos.queueErrorDiscard")}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="border-t border-line pt-3 space-y-3">
        <div className="flex items-baseline justify-between">
          <span className="text-sm font-medium text-ink-600">{t("pos.total")}</span>
          <Money amount={total} size="hero" className="text-[36px]" />
        </div>
        <button
          onClick={onCharge}
          disabled={disabled || items.length === 0}
          className={cn(
            "w-full rounded-lg py-3.5 text-base font-bold text-white transition-colors",
            disabled || items.length === 0
              ? "bg-ink-400 cursor-not-allowed"
              : "bg-gezi-green-700 hover:bg-gezi-green-900 active:scale-[0.98]"
          )}
          style={{ minHeight: "52px" }}
        >
          {t("pos.charge")}
        </button>
      </div>
    </div>
  );
}