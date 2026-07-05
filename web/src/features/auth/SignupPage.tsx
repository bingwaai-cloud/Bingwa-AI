import type React from "react";
import { FormEvent, useMemo, useState } from "react";
import { Building2, Eye, EyeOff, LockKeyhole, Phone, UserRound } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { ApiClientError, signup } from "@/lib/api";
import { detectCarrier, normalizePhone } from "@/lib/phone";
import { cn } from "@/lib/utils";

import { AuthLayout } from "./AuthLayout";
import { useAuth } from "./AuthContext";

export function SignupPage(): React.ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { setAuthenticated } = useAuth();
  const [businessName, setBusinessName] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [ownerPhone, setOwnerPhone] = useState("+256");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const carrier = useMemo(() => detectCarrier(ownerPhone), [ownerPhone]);

  function onPhoneChange(value: string): void {
    setOwnerPhone(normalizePhone(value).slice(0, 13));
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const session = await signup({
        businessName: businessName.trim(),
        ownerName: ownerName.trim(),
        ownerPhone: normalizePhone(ownerPhone),
        password
      });
      setAuthenticated(session);
      navigate("/today", { replace: true });
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 409) setError(t("auth.signup.phoneExists"));
      else if (err instanceof ApiClientError && err.status === 429) setError(t("auth.signup.rateLimited"));
      else setError(t("auth.signup.error"));
    } finally {
      setSubmitting(false);
    }
  }

  const disabled = businessName.trim().length < 2 || ownerName.trim().length < 2 || ownerPhone.length < 13 || password.length < 8;

  return (
    <AuthLayout>
      <section className="rounded-lg border border-line bg-surface-0 p-5 shadow-subtle">
        <p className="text-sm font-semibold text-gezi-green-700">{t("auth.signup.eyebrow")}</p>
        <h1 className="mt-2 text-3xl font-bold tracking-normal text-ink-900">{t("auth.signup.title")}</h1>
        <p className="mt-2 text-sm leading-6 text-ink-600">{t("auth.signup.body")}</p>

        <form className="mt-6 grid gap-4" onSubmit={onSubmit}>
          <label className="grid gap-2 text-sm font-semibold text-ink-900" htmlFor="signup-business">
            {t("auth.signup.businessName")}
            <span className="relative">
              <Building2 className="pointer-events-none absolute left-3 top-1/2 size-5 -translate-y-1/2 text-ink-400" aria-hidden />
              <input id="signup-business" aria-label={t("auth.signup.businessName")} className="h-12 w-full rounded-md border border-line bg-surface-0 py-2 pl-11 pr-3 text-base font-semibold text-ink-900" autoComplete="organization" value={businessName} onChange={(event) => setBusinessName(event.target.value)} />
            </span>
          </label>

          <label className="grid gap-2 text-sm font-semibold text-ink-900" htmlFor="signup-owner">
            {t("auth.signup.ownerName")}
            <span className="relative">
              <UserRound className="pointer-events-none absolute left-3 top-1/2 size-5 -translate-y-1/2 text-ink-400" aria-hidden />
              <input id="signup-owner" aria-label={t("auth.signup.ownerName")} className="h-12 w-full rounded-md border border-line bg-surface-0 py-2 pl-11 pr-3 text-base font-semibold text-ink-900" autoComplete="name" value={ownerName} onChange={(event) => setOwnerName(event.target.value)} />
            </span>
          </label>

          <label className="grid gap-2 text-sm font-semibold text-ink-900" htmlFor="signup-phone">
            {t("auth.signup.ownerPhone")}
            <span className="relative">
              <Phone className="pointer-events-none absolute left-3 top-1/2 size-5 -translate-y-1/2 text-ink-400" aria-hidden />
              <input id="signup-phone" aria-label={t("auth.signup.ownerPhone")} className="h-12 w-full rounded-md border border-line bg-surface-0 py-2 pl-11 pr-24 text-base font-semibold text-ink-900" inputMode="tel" autoComplete="tel" value={ownerPhone} onChange={(event) => onPhoneChange(event.target.value)} />
              <span className={cn("absolute right-2 top-1/2 -translate-y-1/2 rounded-md px-2 py-1 text-xs font-bold", carrier ? "bg-gezi-green-100 text-gezi-green-900" : "bg-surface-1 text-ink-600")}>
                {carrier ? t(`auth.carrier.${carrier}`) : t("auth.carrier.unknown")}
              </span>
            </span>
          </label>

          <label className="grid gap-2 text-sm font-semibold text-ink-900" htmlFor="signup-password">
            {t("auth.signup.password")}
            <span className="relative">
              <LockKeyhole className="pointer-events-none absolute left-3 top-1/2 size-5 -translate-y-1/2 text-ink-400" aria-hidden />
              <input id="signup-password" aria-label={t("auth.signup.password")} className="h-12 w-full rounded-md border border-line bg-surface-0 py-2 pl-11 pr-14 text-base font-semibold text-ink-900" type={showPassword ? "text" : "password"} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} />
              <button type="button" className="absolute right-1 top-1/2 grid size-12 -translate-y-1/2 place-items-center rounded-md text-ink-600" onClick={() => setShowPassword((shown) => !shown)} aria-label={showPassword ? t("auth.signup.hidePassword") : t("auth.signup.showPassword")}>
                {showPassword ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
              </button>
            </span>
          </label>

          <div className="rounded-md border border-line bg-surface-1 px-3 py-2 text-sm font-semibold text-ink-900">
            {t("auth.signup.localeLabel")}: <span className="text-ink-600">{t("auth.signup.localeValue")}</span>
          </div>

          {error ? <p className="rounded-md border border-danger-600 bg-surface-0 px-3 py-2 text-sm font-semibold text-danger-600">{error}</p> : null}

          <Button type="submit" className="mt-1 w-full text-base" disabled={submitting || disabled}>
            {submitting ? t("auth.signup.creating") : t("auth.signup.submit")}
          </Button>
        </form>

        <p className="mt-4 text-center text-sm font-semibold text-ink-600">
          {t("auth.signup.hasAccount")} <Link className="text-gezi-green-700 underline-offset-4 hover:underline" to="/login">{t("auth.signup.loginLink")}</Link>
        </p>
        <p className="mt-4 rounded-md border border-line bg-surface-1 p-3 text-sm font-semibold leading-6 text-ink-600">
          {t("auth.signup.whatsappPath")} <a className="text-gezi-green-700 underline-offset-4 hover:underline" href="https://wa.me/?text=sold%202%20sugar%206k">{t("auth.signup.whatsappLink")}</a>
        </p>
      </section>
    </AuthLayout>
  );
}


