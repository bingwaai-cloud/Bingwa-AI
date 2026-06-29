import { NavLink, Outlet } from "react-router-dom";
import { BarChart3, Boxes, Home, Plus, ReceiptText, Settings, Users } from "lucide-react";
import type React from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const mobileNavItems = [
  { key: "today", href: "/today", icon: Home },
  { key: "sales", href: "/sales", icon: ReceiptText },
  { key: "inventory", href: "/inventory", icon: Boxes },
  { key: "customers", href: "/customers", icon: Users },
  { key: "reports", href: "/reports", icon: BarChart3 }
] as const;

const desktopNavItems = [
  ...mobileNavItems,
  { key: "settings", href: "/settings", icon: Settings }
] as const;

export function AppShell(): React.ReactElement {
  const { t } = useTranslation();

  return (
    <div className="min-h-dvh bg-surface-1 text-ink-900">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-line bg-surface-0 px-4 py-5 md:flex md:flex-col">
        <NavBrand />
        <nav className="mt-8 flex flex-1 flex-col gap-1" aria-label={t("shell.primaryNavigation")}>
          {desktopNavItems.map((item) => (
            <ShellNavLink key={item.key} item={item} />
          ))}
        </nav>
      </aside>

      <div className="md:pl-64">
        <header className="sticky top-0 z-20 border-b border-line bg-surface-0/95 px-4 py-3 backdrop-blur md:px-8">
          <div className="mx-auto flex max-w-6xl items-center justify-between">
            <NavBrand compact />
            <div className="text-right text-xs font-medium text-ink-600">
              <div>{t("shell.session")}</div>
              <div>{t("shell.lastSynced")}</div>
            </div>
          </div>
        </header>

        <main className="mx-auto min-h-[calc(100dvh-73px)] max-w-6xl px-4 pb-28 pt-5 md:px-8 md:pb-10">
          <Outlet />
        </main>
      </div>

      <Button
        className="fixed bottom-24 right-4 z-40 h-14 min-w-14 rounded-full px-5 text-base shadow-subtle md:bottom-8 md:right-8"
        aria-label={t("shell.recordSale")}
      >
        <Plus aria-hidden="true" />
        <span>{t("shell.recordSale")}</span>
      </Button>

      <nav
        className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-line bg-surface-0 px-1 pb-[max(env(safe-area-inset-bottom),0.25rem)] pt-1 md:hidden"
        aria-label={t("shell.primaryNavigation")}
      >
        {mobileNavItems.map((item) => (
          <ShellNavLink key={item.key} item={item} mobile />
        ))}
      </nav>
    </div>
  );
}

function NavBrand({ compact = false }: { compact?: boolean }): React.ReactElement {
  return (
    <div className="flex items-center gap-3">
      <div className="grid size-10 place-items-center rounded-md bg-gezi-green-700 text-base font-bold text-white" aria-hidden="true">
        g
      </div>
      <div className={cn("leading-tight", compact && "md:hidden")}>
        <div className="text-lg font-bold tracking-normal text-ink-900">gezi</div>
        <div className="text-xs font-medium text-ink-600">The champion of your business</div>
      </div>
    </div>
  );
}

type ShellItem = {
  key: string;
  href: string;
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: true }>;
};

function ShellNavLink({ item, mobile = false }: { item: ShellItem; mobile?: boolean }): React.ReactElement {
  const { t } = useTranslation();
  const Icon = item.icon;

  return (
    <NavLink
      to={item.href}
      className={({ isActive }) =>
        cn(
          "touch-target flex items-center gap-3 rounded-md px-3 text-sm font-semibold transition-colors duration-150 ease-gezi",
          "text-ink-600 hover:bg-gezi-green-100 hover:text-gezi-green-900",
          isActive && "bg-gezi-green-100 text-gezi-green-900",
          mobile && "flex-col justify-center gap-1 px-1 py-1 text-[11px] leading-none"
        )
      }
    >
      <Icon className="size-5" aria-hidden />
      <span>{t(`nav.${item.key}`)}</span>
    </NavLink>
  );
}
