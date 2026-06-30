import type React from "react";
import { FormEvent, useRef, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { ApiClientError, verifyRecoveryCode, verifyTwoFactor } from "@/lib/api";

import { AuthLayout } from "./AuthLayout";
import { useAuth } from "./AuthContext";

export function TwoFactorChallengePage(): React.ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { setAuthenticated } = useAuth();
  const [code, setCode] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function appendDigit(digit: string): void {
    setCode((current) => `${current}${digit}`.slice(0, 6));
    inputRef.current?.focus();
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = useRecovery ? await verifyRecoveryCode(recoveryCode.trim()) : await verifyTwoFactor(code);
      if (result.tenant && result.user) setAuthenticated({ tenant: result.tenant, user: result.user });
      navigate("/today", { replace: true });
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 429) setError(t("auth.twoFactor.rateLimited"));
      else setError(useRecovery ? t("auth.twoFactor.recoveryError") : t("auth.twoFactor.error"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout>
      <section className="rounded-lg border border-line bg-surface-0 p-5 shadow-subtle">
        <div className="flex size-12 items-center justify-center rounded-md bg-gezi-green-100 text-gezi-green-700">
          <ShieldCheck aria-hidden />
        </div>
        <h1 className="mt-4 text-3xl font-bold tracking-normal text-ink-900">{t("auth.twoFactor.title")}</h1>
        <p className="mt-2 text-sm leading-6 text-ink-600">{t("auth.twoFactor.body")}</p>

        <form className="mt-6 grid gap-4" onSubmit={onSubmit}>
          {useRecovery ? (
            <label className="grid gap-2 text-sm font-semibold text-ink-900">
              {t("auth.twoFactor.recoveryLabel")}
              <input className="h-12 w-full rounded-md border border-line bg-surface-0 px-3 text-base font-semibold text-ink-900" autoComplete="one-time-code" value={recoveryCode} onChange={(event) => setRecoveryCode(event.target.value)} />
            </label>
          ) : (
            <>
              <label className="grid gap-2 text-sm font-semibold text-ink-900">
                {t("auth.twoFactor.code")}
                <input ref={inputRef} className="h-16 w-full rounded-md border border-line bg-surface-0 px-3 text-center text-3xl font-bold tracking-[0.35em] text-ink-900" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} />
              </label>
              <div className="grid grid-cols-3 gap-2" aria-label={t("auth.twoFactor.keypad")}> 
                {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((digit) => (
                  <button key={digit} type="button" className="h-14 rounded-md border border-line bg-surface-0 text-xl font-bold text-ink-900" onClick={() => appendDigit(digit)}>{digit}</button>
                ))}
                <button type="button" className="h-14 rounded-md border border-line bg-surface-0 text-sm font-bold text-ink-600" onClick={() => setCode("")}>{t("auth.twoFactor.clear")}</button>
                <button type="button" className="h-14 rounded-md border border-line bg-surface-0 text-xl font-bold text-ink-900" onClick={() => appendDigit("0")}>0</button>
                <button type="button" className="h-14 rounded-md border border-line bg-surface-0 text-sm font-bold text-ink-600" onClick={() => setCode((current) => current.slice(0, -1))}>{t("auth.twoFactor.back")}</button>
              </div>
            </>
          )}

          {error ? <p className="rounded-md border border-danger-600/30 bg-red-50 px-3 py-2 text-sm font-semibold text-danger-600">{error}</p> : null}

          <Button type="submit" className="w-full text-base" disabled={submitting || (useRecovery ? recoveryCode.trim().length < 8 : code.length !== 6)}>
            {submitting ? t("auth.twoFactor.checking") : t("auth.twoFactor.submit")}
          </Button>
          <button type="button" className="min-h-12 rounded-md px-3 text-sm font-bold text-gezi-green-700" onClick={() => { setUseRecovery((current) => !current); setError(null); }}>
            {useRecovery ? t("auth.twoFactor.useTotp") : t("auth.twoFactor.useRecovery")}
          </button>
        </form>
      </section>
    </AuthLayout>
  );
}
