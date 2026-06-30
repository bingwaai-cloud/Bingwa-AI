import type React from "react";
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { getSession, type AuthSession } from "@/lib/api";

export type AuthStatus = "checking" | "authenticated" | "unauthenticated" | "two_factor_required";

type AuthContextValue = {
  session: AuthSession | null;
  status: AuthStatus;
  setAuthenticated: (session: AuthSession) => void;
  setTwoFactorRequired: () => void;
  requireServerSession: () => Promise<AuthSession | null>;
  clearSession: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

function isTwoFactorRequired(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { status?: number; message?: string; code?: string };
  return candidate.status === 401 && (candidate.message?.toLowerCase().includes("two-factor") || candidate.code === "TWO_FACTOR_REQUIRED");
}

export function AuthProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [status, setStatus] = useState<AuthStatus>("checking");

  const setAuthenticated = useCallback((nextSession: AuthSession): void => {
    setSession(nextSession);
    setStatus("authenticated");
  }, []);

  const setTwoFactorRequired = useCallback((): void => {
    setSession(null);
    setStatus("two_factor_required");
  }, []);

  const clearSession = useCallback((): void => {
    setSession(null);
    setStatus("unauthenticated");
  }, []);

  const requireServerSession = useCallback(async (): Promise<AuthSession | null> => {
    setStatus((current) => (current === "authenticated" ? current : "checking"));
    try {
      const nextSession = await getSession();
      setAuthenticated(nextSession);
      return nextSession;
    } catch (error) {
      if (isTwoFactorRequired(error)) setTwoFactorRequired();
      else clearSession();
      return null;
    }
  }, [clearSession, setAuthenticated, setTwoFactorRequired]);

  const value = useMemo<AuthContextValue>(() => ({
    session,
    status,
    setAuthenticated,
    setTwoFactorRequired,
    requireServerSession,
    clearSession
  }), [clearSession, requireServerSession, session, setAuthenticated, setTwoFactorRequired, status]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}
