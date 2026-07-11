import type React from "react";

export function AuthLayout({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <main className="min-h-dvh bg-surface-1 px-4 py-6 text-ink-900">
      <div className="mx-auto flex min-h-[calc(100dvh-3rem)] w-full max-w-md flex-col justify-center">
        <div className="mb-6 flex items-center gap-3">
          <img src="/brand/gezi-mark.svg" alt="Gezi AI" className="size-11" />
          <div>
            <img src="/brand/gezi-wordmark.svg" alt="gezi" className="h-7 w-auto" />
            <div className="text-sm font-medium text-ink-600">The champion of your business</div>
          </div>
        </div>
        {children}
      </div>
    </main>
  );
}
