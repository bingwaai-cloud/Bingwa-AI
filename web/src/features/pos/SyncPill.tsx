import type React from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { SyncStatus } from "./useOfflineQueue";

type SyncPillProps = {
  status: SyncStatus;
  count: number;
  className?: string;
};

export function SyncPill({ status, count, className }: SyncPillProps): React.ReactElement {
  const { t } = useTranslation();

  const baseClasses = "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors";

  const config: Record<SyncStatus, { className: string; label: string }> = {
    synced: {
      className: "bg-gezi-green-100 text-gezi-green-700",
      label: t("pos.syncSynced")
    },
    queued: {
      className: "bg-warn-600/15 text-warn-600",
      label: t("pos.syncQueued", { count })
    },
    needs_attention: {
      className: "bg-danger-600/15 text-danger-600",
      label: t("pos.syncNeedsAttention")
    }
  };

  const { className: styleClass, label } = config[status];

  return (
    <span className={cn(baseClasses, styleClass, className)}>
      <span
        className={cn(
          "inline-block h-2 w-2 rounded-full",
          status === "synced" && "bg-gezi-green-700",
          status === "queued" && "bg-warn-600",
          status === "needs_attention" && "bg-danger-600"
        )}
      />
      {label}
    </span>
  );
}