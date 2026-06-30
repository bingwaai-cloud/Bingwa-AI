import type React from "react";
import { lazy, Suspense } from "react";
import { createBrowserRouter, Navigate, Outlet } from "react-router-dom";

import { AuthProvider } from "@/features/auth/AuthContext";
import { LoginPage } from "@/features/auth/LoginPage";
import { RequireAuth } from "@/features/auth/RequireAuth";
import { TwoFactorChallengePage } from "@/features/auth/TwoFactorChallengePage";
import { TodayPage } from "@/features/today/TodayPage";
import { AppShell } from "@/shell/AppShell";

const SalesPage = lazy(() => import("@/features/modules/SalesPage").then((module) => ({ default: module.SalesPage })));
const InventoryPage = lazy(() => import("@/features/modules/InventoryPage").then((module) => ({ default: module.InventoryPage })));
const CustomersPage = lazy(() => import("@/features/modules/CustomersPage").then((module) => ({ default: module.CustomersPage })));
const ReportsPage = lazy(() => import("@/features/modules/ReportsPage").then((module) => ({ default: module.ReportsPage })));
const SettingsPage = lazy(() => import("@/features/settings/SettingsPage").then((module) => ({ default: module.SettingsPage })));
const TwoFactorSetupPage = lazy(() => import("@/features/auth/TwoFactorSetupPage").then((module) => ({ default: module.TwoFactorSetupPage })));

function RouteFallback(): React.ReactElement {
  return <div className="h-40 animate-pulse rounded-lg bg-line" />;
}

function lazyRoute(element: React.ReactElement): React.ReactElement {
  return <Suspense fallback={<RouteFallback />}>{element}</Suspense>;
}

export const router = createBrowserRouter([
  {
    element: <AuthProvider><OutletRoot /></AuthProvider>,
    children: [
      { path: "/login", element: <LoginPage /> },
      { path: "/2fa", element: <TwoFactorChallengePage /> },
      {
        element: <RequireAuth />,
        children: [
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
              { path: "settings", element: lazyRoute(<SettingsPage />) },
              { path: "settings/2fa", element: lazyRoute(<TwoFactorSetupPage />) }
            ]
          }
        ]
      }
    ]
  }
]);

function OutletRoot(): React.ReactElement {
  return <Outlet />;
}
