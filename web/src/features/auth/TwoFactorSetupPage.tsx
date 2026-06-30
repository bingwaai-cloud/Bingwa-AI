import type React from "react";
import { FormEvent, useEffect, useState } from "react";
import { Check, Copy, Download, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { ApiClientError, setupTwoFactor, verifyTwoFactorSetup } from "@/lib/api";

import { useAuth } from "./AuthContext";

export function TwoFactorSetupPage(): React.ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { requireServerSession } = useAuth();
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [provisioningUri, setProvisioningUri] = useState("");
  const [code, setCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let mounted = true;
    async function startSetup(): Promise<void> {
      try {
        const [result, qrcode] = await Promise.all([setupTwoFactor(), import("qrcode")]);
        const dataUrl = await qrcode.toDataURL(result.provisioningUri, { margin: 1, width: 220 });
        if (mounted) {
          setProvisioningUri(result.provisioningUri);
          setQrDataUrl(dataUrl);
        }
      } catch {
        if (mounted) setError(t("auth.setup.loadError"));
      } finally {
        if (mounted) setLoading(false);
      }
    }
    void startSetup();
    return () => { mounted = false; };
  }, [t]);

  async function onVerify(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await verifyTwoFactorSetup(code);
      setRecoveryCodes(result.recoveryCodes ?? []);
      await requireServerSession();
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 429) setError(t("auth.setup.rateLimited"));
      else setError(t("auth.setup.verifyError"));
    } finally {
      setSubmitting(false);
    }
  }

  async function copyCodes(): Promise<void> {
    await navigator.clipboard.writeText(recoveryCodes.join("\n"));
    setCopied(true);
  }

  function downloadCodes(): void {
    const blob = new Blob([recoveryCodes.join("\n")], { type: "text/plain;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href;
    link.download = "gezi-recovery-codes.txt";
    link.click();
    URL.revokeObjectURL(href);
  }

  if (recoveryCodes.length > 0) {
    return (
      <section className="mx-auto max-w-2xl rounded-lg border border-line bg-surface-0 p-5 shadow-subtle">
        <div className="flex size-12 items-center justify-center rounded-md bg-gezi-green-100 text-gezi-green-700"><Check aria-hidden /></div>
        <h1 className="mt-4 text-2xl font-bold text-ink-900">{t("auth.setup.codesTitle")}</h1>
        <p className="mt-2 text-sm leading-6 text-ink-600">{t("auth.setup.codesBody")}</p>
        <div className="mt-4 grid gap-2 rounded-md border border-line bg-surface-1 p-3 font-mono text-sm font-bold text-ink-900">
          {recoveryCodes.map((item) => <div key={item}>{item}</div>)}
        </div>
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          <Button type="button" variant="secondary" onClick={copyCodes}><Copy aria-hidden />{copied ? t("auth.setup.copied") : t("auth.setup.copy")}</Button>
          <Button type="button" variant="secondary" onClick={downloadCodes}><Download aria-hidden />{t("auth.setup.download")}</Button>
        </div>
        <Button className="mt-4 w-full" onClick={() => navigate("/today", { replace: true })}>{t("auth.setup.saved")}</Button>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-2xl rounded-lg border border-line bg-surface-0 p-5 shadow-subtle">
      <div className="flex size-12 items-center justify-center rounded-md bg-gezi-green-100 text-gezi-green-700"><ShieldCheck aria-hidden /></div>
      <h1 className="mt-4 text-2xl font-bold text-ink-900">{t("auth.setup.title")}</h1>
      <p className="mt-2 text-sm leading-6 text-ink-600">{t("auth.setup.body")}</p>

      <div className="mt-5 grid justify-items-center gap-3 rounded-lg border border-line bg-surface-1 p-4 text-center">
        {loading ? <div className="size-56 animate-pulse rounded-md bg-line" aria-label={t("auth.setup.loading")} /> : null}
        {qrDataUrl ? <img className="size-56 rounded-md border border-line bg-white p-2" src={qrDataUrl} alt={t("auth.setup.qrAlt")} /> : null}
        <p className="max-w-full break-all text-xs font-semibold text-ink-600">{provisioningUri}</p>
      </div>

      <form className="mt-5 grid gap-3" onSubmit={onVerify}>
        <label className="grid gap-2 text-sm font-semibold text-ink-900">
          {t("auth.setup.code")}
          <input className="h-14 w-full rounded-md border border-line bg-surface-0 px-3 text-center text-2xl font-bold tracking-[0.3em] text-ink-900" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} />
        </label>
        {error ? <p className="rounded-md border border-danger-600/30 bg-red-50 px-3 py-2 text-sm font-semibold text-danger-600">{error}</p> : null}
        <Button type="submit" disabled={submitting || code.length !== 6}>{submitting ? t("auth.setup.verifying") : t("auth.setup.verify")}</Button>
      </form>
    </section>
  );
}
