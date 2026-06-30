import type React from "react";

export function AuthLayout({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <main className="min-h-dvh bg-surface-1 px-4 py-6 text-ink-900">
      <div className="mx-auto flex min-h-[calc(100dvh-3rem)] w-full max-w-md flex-col justify-center">
        <div className="mb-6 flex items-center gap-3">
          <div className="grid size-11 place-items-center rounded-md bg-gezi-green-700 text-lg font-bold text-white" aria-hidden="true">
            g
          </div>
          <div>
            <div className="text-xl font-bold tracking-normal text-ink-900">gezi</div>
            <div className="text-sm font-medium text-ink-600">The champion of your business</div>
          </div>
        </div>
        {children}
      </div>
    </main>
  );
}
