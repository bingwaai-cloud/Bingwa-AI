import { createBrowserRouter, Navigate } from "react-router-dom";

import { TodayPage } from "@/features/today/TodayPage";
import { AppShell } from "@/shell/AppShell";
import { PlaceholderRoute } from "@/shell/PlaceholderRoute";

export const router = createBrowserRouter([
  {
    path: "/",
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/today" replace /> },
      { path: "today", element: <TodayPage /> },
      { path: "sales", element: <PlaceholderRoute routeKey="sales" /> },
      { path: "inventory", element: <PlaceholderRoute routeKey="inventory" /> },
      { path: "customers", element: <PlaceholderRoute routeKey="customers" /> },
      { path: "reports", element: <PlaceholderRoute routeKey="reports" /> },
      { path: "settings", element: <PlaceholderRoute routeKey="settings" /> }
    ]
  }
]);
