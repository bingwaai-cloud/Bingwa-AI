import type React from "react";
import { lazy, Suspense } from "react";
import { createBrowserRouter, Navigate } from "react-router-dom";

import { TodayPage } from "@/features/today/TodayPage";
import { AppShell } from "@/shell/AppShell";
import { PlaceholderRoute } from "@/shell/PlaceholderRoute";

const SalesPage = lazy(() => import("@/features/modules/SalesPage").then((module) => ({ default: module.SalesPage })));
const InventoryPage = lazy(() => import("@/features/modules/InventoryPage").then((module) => ({ default: module.InventoryPage })));
const CustomersPage = lazy(() => import("@/features/modules/CustomersPage").then((module) => ({ default: module.CustomersPage })));
const ReportsPage = lazy(() => import("@/features/modules/ReportsPage").then((module) => ({ default: module.ReportsPage })));

function RouteFallback(): React.ReactElement {
  return <div className="h-40 animate-pulse rounded-lg bg-line" />;
}

function lazyRoute(element: React.ReactElement): React.ReactElement {
  return <Suspense fallback={<RouteFallback />}>{element}</Suspense>;
}

export const router = createBrowserRouter([
  {
    path: "/",
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/today" replace /> },
      { path: "today", element: <TodayPage /> },
      { path: "sales", element: lazyRoute(<SalesPage />) },
      { path: "inventory", element: lazyRoute(<InventoryPage />) },
      { path: "customers", element: lazyRoute(<CustomersPage />) },
      { path: "reports", element: lazyRoute(<ReportsPage />) },
      { path: "settings", element: <PlaceholderRoute routeKey="settings" /> }
    ]
  }
]);
