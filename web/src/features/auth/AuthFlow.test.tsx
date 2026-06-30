import "@/i18n";

import type React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import i18n from "i18next";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthProvider } from "./AuthContext";
import { LoginPage } from "./LoginPage";
import { RequireAuth } from "./RequireAuth";
import { TwoFactorChallengePage } from "./TwoFactorChallengePage";
import { TwoFactorSetupPage } from "./TwoFactorSetupPage";

vi.mock("qrcode", () => ({
  toDataURL: vi.fn(async () => "data:image/png;base64,qr")
}));

function success<T>(data: T): Response {
  return new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function failure(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ success: false, error: { code, message } }), { status, headers: { "Content-Type": "application/json" } });
}

const tenant = { id: "tenant-1", businessName: "Nakato Shop", ownerPhone: "+256771234567" };
const owner = { id: "user-1", phone: "+256771234567", name: "Nakato", role: "owner", totpEnabled: true };

function renderAuth(initialEntries: string[], children: React.ReactNode): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const router = createMemoryRouter([
    {
      element: <AuthProvider>{children}<Outlet /></AuthProvider>,
      children: [
        { path: "/login", element: <LoginPage /> },
        { path: "/2fa", element: <TwoFactorChallengePage /> },
        { path: "/settings/2fa", element: <RequireAuth />, children: [{ index: true, element: <TwoFactorSetupPage /> }] },
        { path: "/today", element: <RequireAuth />, children: [{ index: true, element: <h1>Dashboard</h1> }] },
        { path: "/", element: <RequireAuth />, children: [{ index: true, element: <h1>Dashboard</h1> }] }
      ]
    }
  ], { initialEntries });
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
}

describe("auth UI flow", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(async () => undefined) } });
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:codes") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  });

  afterEach(async () => {
    await i18n.changeLanguage("en");
    vi.unstubAllGlobals();
  });

  it("login returns 2fa_pending, challenge succeeds, and dashboard renders", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/v1/auth/login") return success({ twoFactorRequired: true, tenant, user: owner });
      if (url.pathname === "/api/v1/auth/2fa/verify" && init?.method === "POST") return success({ tenant, user: owner });
      if (url.pathname === "/api/v1/auth/session") return success({ tenant, user: owner });
      throw new Error(`Unexpected request ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderAuth(["/login"], null);
    fireEvent.change(screen.getByLabelText("Phone number"), { target: { value: "0772123456" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("Enter your 6-digit code")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Authentication code"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByText("Dashboard")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/v1/auth/login"), expect.objectContaining({ credentials: "include" }));
  });

  it("wrong TOTP stays on challenge and protected content does not leak", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/v1/auth/2fa/verify") return failure(401, "UNAUTHORIZED", "Invalid two-factor code.");
      throw new Error(`Unexpected request ${url.pathname}`);
    }));

    renderAuth(["/2fa"], null);
    fireEvent.change(screen.getByLabelText("Authentication code"), { target: { value: "000000" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByText("That code did not work. Try the newest code from your app.")).toBeInTheDocument();
    expect(screen.queryByText("Dashboard")).not.toBeInTheDocument();
  });

  it("offers and accepts the recovery-code path", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/v1/auth/2fa/recovery") return success({ tenant, user: owner });
      if (url.pathname === "/api/v1/auth/session") return success({ tenant, user: owner });
      throw new Error(`Unexpected request ${url.pathname}`);
    }));

    renderAuth(["/2fa"], null);
    fireEvent.click(screen.getByRole("button", { name: "Use a recovery code" }));
    fireEvent.change(screen.getByLabelText("Recovery code"), { target: { value: "abcd1234-abcd1234" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByText("Dashboard")).toBeInTheDocument();
  });

  it("setup flow lazy-renders QR, verifies, then shows recovery codes once", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/v1/auth/session") return success({ tenant, user: { ...owner, totpEnabled: false } });
      if (url.pathname === "/api/v1/auth/2fa/setup") return success({ provisioningUri: "otpauth://totp/Gezi?secret=ABC" });
      if (url.pathname === "/api/v1/auth/2fa/verify") return success({ totpEnabled: true, recoveryCodes: ["code-one", "code-two"] });
      throw new Error(`Unexpected request ${url.pathname}`);
    }));

    renderAuth(["/settings/2fa"], null);
    expect(await screen.findByAltText("Authenticator setup QR code")).toHaveAttribute("src", "data:image/png;base64,qr");
    fireEvent.change(screen.getByLabelText("Enter the 6-digit code"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify and turn on" }));

    expect(await screen.findByText("Save these recovery codes")).toBeInTheDocument();
    expect(screen.getByText("code-one")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy codes" }));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("401 attempts one silent refresh and then redirects to login", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/v1/auth/session") return failure(401, "TOKEN_EXPIRED", "Token expired");
      if (url.pathname === "/api/v1/auth/refresh") return failure(401, "UNAUTHORIZED", "Invalid refresh token");
      throw new Error(`Unexpected request ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderAuth(["/today"], null);

    expect(await screen.findByText("Sign in to Gezi")).toBeInTheDocument();
    const paths = fetchMock.mock.calls.map(([input]) => new URL(String(input), "http://localhost").pathname);
    expect(paths).toEqual(["/api/v1/auth/session", "/api/v1/auth/refresh"]);
  });

  it("never stores auth tokens in localStorage or sessionStorage", async () => {
    const localSet = vi.spyOn(Storage.prototype, "setItem");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/v1/auth/login") return success({ tenant, user: owner });
      if (url.pathname === "/api/v1/auth/session") return success({ tenant, user: owner });
      throw new Error(`Unexpected request ${url.pathname}`);
    }));

    renderAuth(["/login"], null);
    fireEvent.change(screen.getByLabelText("Phone number"), { target: { value: "0772123456" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("Dashboard")).toBeInTheDocument();
    expect(localSet).not.toHaveBeenCalled();
    expect(localStorage.getItem("accessToken")).toBeNull();
    expect(sessionStorage.getItem("accessToken")).toBeNull();
  });

  it("auth strings render in Luganda without breaking the mobile card", async () => {
    await i18n.changeLanguage("lg");
    renderAuth(["/login"], null);

    expect(screen.getByText("Yingira mu Gezi")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Yingira" })).toHaveClass("h-12");
  });
});
