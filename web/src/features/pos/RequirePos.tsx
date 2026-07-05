import type React from "react";
import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "@/features/auth/AuthContext";

const POS_ROLES = new Set(["owner", "manager", "cashier"]);

export function RequirePos(): React.ReactElement {
  const { session, status } = useAuth();

  if (status !== "authenticated" || !session) {
    return <Navigate to="/login" replace />;
  }

  if (!POS_ROLES.has(session.user.role)) {
    return <Navigate to="/today" replace />;
  }

  return <Outlet />;
}