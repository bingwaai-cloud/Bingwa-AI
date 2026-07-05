import type React from "react";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

type NumericKeypadProps = {
  value: string;
  onChange: (value: string) => void;
  onClose: () => void;
  title?: string;
};

const DIGITS = [
  ["1", "2", "3"],
  ["4", "5", "6"],
  ["7", "8", "9"],
  ["C", "0", "\u232B"]
];

export function NumericKeypad({ value, onChange, onClose, title }: NumericKeypadProps): React.ReactElement {
  const { t } = useTranslation();

  const handlePress = useCallback(
    (key: string) => {
      if (key === "C") {
        onChange("0");
      } else if (key === "\u232B") {
        const next = value.length > 1 ? value.slice(0, -1) : "0";
        onChange(next);
      } else {
        const next = value === "0" ? key : value + key;
        // Limit to 9 digits (~99M UGX)
        if (next.length <= 9) onChange(next);
      }
    },
    [value, onChange]
  );

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-t-xl bg-surface-0 p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-medium text-ink-600">{title ?? t("pos.keypadTitle")}</span>
          <button
            onClick={onClose}
            className="flex h-10 w-10 items-center justify-center rounded-full text-ink-400 hover:bg-surface-1"
            aria-label={t("common.close")}
          >
            <X size={20} />
          </button>
        </div>

        <div className="mb-3 rounded-lg bg-surface-1 px-4 py-3 text-center text-[32px] font-bold tabular-nums text-ink-900">
          {parseInt(value, 10).toLocaleString("en-UG")}
        </div>

        <div className="grid grid-cols-3 gap-2">
          {DIGITS.map((row, ri) =>
            row.map((key) => (
              <button
                key={`${ri}-${key}`}
                onClick={() => handlePress(key)}
                className={cn(
                  "flex h-14 items-center justify-center rounded-lg text-xl font-semibold transition-colors active:scale-95",
                  key === "C"
                    ? "bg-danger-600/10 text-danger-600 hover:bg-danger-600/20"
                    : "\u232B" === key
                      ? "bg-ink-400/10 text-ink-600 hover:bg-ink-400/20"
                      : "bg-surface-1 text-ink-900 hover:bg-line"
                )}
                style={{ minHeight: "56px" }}
              >
                {key}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}