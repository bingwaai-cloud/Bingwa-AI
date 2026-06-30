import type React from "react";
import { useEffect } from "react";
import { Navigate, Outlet } from "react-router-dom";

import { useAuth } from "./AuthContext";

export function RequireAuth(): React.ReactElement {
  const { status, requireServerSession } = useAuth();

  useEffect(() => {
    if (status === "checking") void requireServerSession();
  }, [requireServerSession, status]);

  if (status === "authenticated") return <Outlet />;
  if (status === "two_factor_required") return <Navigate to="/2fa" replace />;
  if (status === "unauthenticated") return <Navigate to="/login" replace />;

  return (
    <main className="grid min-h-dvh place-items-center bg-surface-1 px-4 text-ink-900">
      <div className="h-32 w-full max-w-sm animate-pulse rounded-lg bg-line" />
    </main>
  );
}
