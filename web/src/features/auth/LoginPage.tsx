import type React from "react";
import { FormEvent, useMemo, useState } from "react";
import { Eye, EyeOff, LockKeyhole, Phone } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { ApiClientError, login } from "@/lib/api";
import { detectCarrier, normalizePhone } from "@/lib/phone";
import { cn } from "@/lib/utils";

import { AuthLayout } from "./AuthLayout";
import { useAuth } from "./AuthContext";

export function LoginPage(): React.ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { setAuthenticated, setTwoFactorRequired } = useAuth();
  const [phone, setPhone] = useState("+256");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const carrier = useMemo(() => detectCarrier(phone), [phone]);

  function onPhoneChange(value: string): void {
    setPhone(normalizePhone(value).slice(0, 13));
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await login(normalizePhone(phone), password);
      if (result.twoFactorRequired) {
        setTwoFactorRequired();
        navigate("/2fa", { replace: true });
      } else {
        setAuthenticated(result);
        navigate(result.user.role === "owner" && !result.user.totpEnabled ? "/settings/2fa" : "/today", { replace: true });
      }
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 429) setError(t("auth.login.rateLimited"));
      else setError(t("auth.login.error"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout>
      <section className="rounded-lg border border-line bg-surface-0 p-5 shadow-subtle">
        <p className="text-sm font-semibold text-gezi-green-700">{t("auth.login.eyebrow")}</p>
        <h1 className="mt-2 text-3xl font-bold tracking-normal text-ink-900">{t("auth.login.title")}</h1>
        <p className="mt-2 text-sm leading-6 text-ink-600">{t("auth.login.body")}</p>

        <form className="mt-6 grid gap-4" onSubmit={onSubmit}>
          <div className="grid gap-2 text-sm font-semibold text-ink-900">
            <label htmlFor="login-phone">{t("auth.login.phone")}</label>
            <span className="relative">
              <Phone className="pointer-events-none absolute left-3 top-1/2 size-5 -translate-y-1/2 text-ink-400" aria-hidden />
              <input
                id="login-phone"
                className="h-12 w-full rounded-md border border-line bg-surface-0 py-2 pl-11 pr-24 text-base font-semibold text-ink-900"
                inputMode="tel"
                autoComplete="tel"
                value={phone}
                onChange={(event) => onPhoneChange(event.target.value)}
              />
              <span className={cn("absolute right-2 top-1/2 -translate-y-1/2 rounded-md px-2 py-1 text-xs font-bold", carrier ? "bg-gezi-green-100 text-gezi-green-900" : "bg-surface-1 text-ink-600")}>
                {carrier ? t(`auth.carrier.${carrier}`) : t("auth.carrier.unknown")}
              </span>
            </span>
          </div>

          <div className="grid gap-2 text-sm font-semibold text-ink-900">
            <label htmlFor="login-password">{t("auth.login.password")}</label>
            <span className="relative">
              <LockKeyhole className="pointer-events-none absolute left-3 top-1/2 size-5 -translate-y-1/2 text-ink-400" aria-hidden />
              <input
                id="login-password"
                className="h-12 w-full rounded-md border border-line bg-surface-0 py-2 pl-11 pr-14 text-base font-semibold text-ink-900"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              <button type="button" className="absolute right-1 top-1/2 grid size-12 -translate-y-1/2 place-items-center rounded-md text-ink-600" onClick={() => setShowPassword((shown) => !shown)} aria-label={showPassword ? t("auth.login.hidePassword") : t("auth.login.showPassword")}>
                {showPassword ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
              </button>
            </span>
          </div>

          {error ? <p className="rounded-md border border-danger-600/30 bg-red-50 px-3 py-2 text-sm font-semibold text-danger-600">{error}</p> : null}

          <Button type="submit" className="mt-1 w-full text-base" disabled={submitting || phone.length < 13 || password.length === 0}>
            {submitting ? t("auth.login.signingIn") : t("auth.login.submit")}
          </Button>
        </form>
      </section>
    </AuthLayout>
  );
}
