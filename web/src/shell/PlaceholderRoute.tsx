import { ShieldCheck } from "lucide-react";
import type React from "react";
import { useTranslation } from "react-i18next";

import { Money } from "@/components/Money";

type PlaceholderRouteProps = {
  routeKey: "today" | "sales" | "inventory" | "customers" | "reports" | "settings";
};

export function PlaceholderRoute({ routeKey }: PlaceholderRouteProps): React.ReactElement {
  const { t } = useTranslation();

  return (
    <section className="grid gap-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-semibold text-gezi-green-700">{t("shell.product")}</p>
          <h1 className="mt-1 text-2xl font-bold tracking-normal text-ink-900">{t(`routes.${routeKey}.title`)}</h1>
        </div>
        <div className="flex min-h-12 items-center gap-2 rounded-md border border-line bg-surface-0 px-3 text-sm font-semibold text-ink-600">
          <ShieldCheck className="size-5 text-gezi-green-700" aria-hidden />
          <span>{t("shell.secure")}</span>
        </div>
      </div>

      <div className="rounded-lg border border-line bg-surface-0 p-4 shadow-subtle">
        <p className="text-sm font-medium text-ink-600">{t(`routes.${routeKey}.eyebrow`)}</p>
        <div className="mt-3">
          <Money amount={70000} size={routeKey === "today" ? "hero" : "card"} tone="positive" />
        </div>
        <p className="mt-3 max-w-xl text-sm leading-6 text-ink-600">{t(`routes.${routeKey}.body`)}</p>
      </div>
    </section>
  );
}
