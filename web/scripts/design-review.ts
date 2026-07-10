import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(webRoot, "..");
const outputRoot = path.join(repoRoot, "docs", "design-review");
const port = 4173;
const baseUrl = `http://127.0.0.1:${port}`;

const session = {
  tenant: { id: "tenant-review", businessName: "Nakato Groceries", ownerPhone: "+256772123456" },
  user: { id: "user-review", phone: "+256772123456", name: "Amina Nakato", role: "owner", totpEnabled: true }
};

const now = "2026-07-10T12:32:00.000Z";
const yesterday = "2026-07-09T09:14:00.000Z";
const twoDaysAgo = "2026-07-08T15:06:00.000Z";

const sales = [
  { id: "sale-1", itemName: "Sugar", qty: 2, unitPrice: 6000, totalPrice: 12000, source: "whatsapp", createdAt: now, lines: [{ id: "line-1", itemName: "Sugar", qty: 2, unit: "kg", unitPrice: 6000, totalPrice: 12000, createdAt: now }] },
  { id: "sale-2", itemName: "Laundry soap", qty: 3, unitPrice: 4500, totalPrice: 13500, source: "pos", createdAt: yesterday, lines: [{ id: "line-2", itemName: "Laundry soap", qty: 3, unit: "bar", unitPrice: 4500, totalPrice: 13500, createdAt: yesterday }] },
  { id: "sale-3", itemName: "Cooking oil", qty: 1, unitPrice: 18000, totalPrice: 18000, source: "web", createdAt: twoDaysAgo, lines: [{ id: "line-3", itemName: "Cooking oil", qty: 1, unit: "bottle", unitPrice: 18000, totalPrice: 18000, createdAt: twoDaysAgo }] }
];

const purchases = [
  { id: "purchase-1", itemName: "Sugar", qty: 25, unitPrice: 5200, totalPrice: 130000, source: "whatsapp", createdAt: yesterday }
];

const inventory = [
  { id: "item-1", name: "Sugar", unit: "kg", qtyInStock: 8, lowStockThreshold: 10, typicalSellPrice: 6000, typicalBuyPrice: 5200, createdAt: twoDaysAgo, updatedAt: now, lastSoldAt: now },
  { id: "item-2", name: "Laundry soap", unit: "bar", qtyInStock: 42, lowStockThreshold: 12, typicalSellPrice: 4500, typicalBuyPrice: 3600, createdAt: twoDaysAgo, updatedAt: yesterday, lastSoldAt: yesterday },
  { id: "item-3", name: "Cooking oil", unit: "bottle", qtyInStock: 16, lowStockThreshold: 8, typicalSellPrice: 18000, typicalBuyPrice: 15000, createdAt: twoDaysAgo, updatedAt: twoDaysAgo, lastSoldAt: twoDaysAgo }
];

const customers = [
  { id: "customer-1", phone: "+256701234567", name: "Grace Namusoke", notes: "Prefers morning delivery", visitCount: 8, totalPurchases: 184000, lastVisitedAt: now, optedInMarketing: true, createdAt: twoDaysAgo, updatedAt: now },
  { id: "customer-2", phone: "+256758765432", name: "Moses Kato", notes: null, visitCount: 3, totalPurchases: 72000, lastVisitedAt: yesterday, optedInMarketing: false, createdAt: twoDaysAgo, updatedAt: yesterday }
];

const expenses = [
  { id: "expense-1", name: "Shop rent", amountUgx: 350000, frequency: "monthly", dueDay: 5, lastPaidAt: "2026-07-05T08:00:00.000Z", nextDueAt: "2026-08-05T08:00:00.000Z", notes: "Front unit", createdAt: twoDaysAgo },
  { id: "expense-2", name: "Transport", amountUgx: 18000, frequency: "weekly", dueDay: null, lastPaidAt: yesterday, nextDueAt: null, notes: null, createdAt: twoDaysAgo }
];

const drafts = [
  { id: "draft-1", userPhone: "+256772123456", action: "sale", payload: { items: [{ item: "Sugar", qty: 2, unitPrice: 6000 }] }, state: "pending_clarification", clarificationQuestion: "Which size of sugar should I use?", committedEntityId: null, expiresAt: "2026-07-10T15:00:00.000Z", createdAt: now, updatedAt: now }
];

function envelope(data, meta) {
  return JSON.stringify({ success: true, data, ...(meta ? { meta } : {}) });
}

function summary(groupBy) {
  const buckets = groupBy === "month"
    ? [{ periodStart: "2026-07-01T00:00:00.000Z", totalUgx: 43500, count: 3 }]
    : groupBy === "week"
      ? [{ periodStart: "2026-07-07T00:00:00.000Z", totalUgx: 25500, count: 2 }, { periodStart: "2026-07-09T00:00:00.000Z", totalUgx: 18000, count: 1 }]
      : [{ periodStart: twoDaysAgo, totalUgx: 18000, count: 1 }, { periodStart: yesterday, totalUgx: 13500, count: 1 }, { periodStart: now, totalUgx: 12000, count: 1 }];
  return { groupBy, from: "2026-07-01T00:00:00.000Z", to: now, buckets, totalUgx: buckets.reduce((total, bucket) => total + bucket.totalUgx, 0), count: buckets.reduce((total, bucket) => total + bucket.count, 0) };
}

async function responseFor(url, method) {
  const parsed = new URL(url);
  const pathname = parsed.pathname;
  if (pathname === "/api/v1/auth/session" || pathname === "/api/v1/auth/refresh") return envelope(session);
  if (pathname === "/api/v1/auth/login" || pathname === "/api/v1/auth/signup") return envelope(session);
  if (pathname === "/api/v1/auth/setup") return envelope({ provisioningUri: "otpauth://totp/Gezi%20AI:Nakato%20Groceries?secret=GEZIREVIEW2026" });
  if (pathname === "/api/v1/auth/2fa/verify") return envelope({ ...session, totpEnabled: true, recoveryCodes: ["GEZI-1234", "GEZI-5678", "GEZI-9012"] });
  if (pathname === "/api/v1/auth/2fa/recovery") return envelope(session);
  if (pathname === "/api/v1/sales/summary/today") return envelope({ totalRevenue: 12000, saleCount: 1 });
  if (pathname === "/api/v1/sales/summary") return envelope(summary(parsed.searchParams.get("groupBy") || "day"));
  if (pathname === "/api/v1/purchases/summary") return envelope({ ...summary(parsed.searchParams.get("groupBy") || "day"), totalUgx: 130000 });
  if (pathname === "/api/v1/sales" || pathname.startsWith("/api/v1/sales?")) return envelope(sales, { total: sales.length, page: 1, perPage: 20 });
  if (pathname === "/api/v1/purchases" || pathname.startsWith("/api/v1/purchases?")) return envelope(purchases, { total: purchases.length, page: 1, perPage: 20 });
  if (pathname === "/api/v1/expenses" || pathname.startsWith("/api/v1/expenses?")) return envelope(expenses, { total: expenses.length, page: 1, perPage: 20 });
  if (pathname === "/api/v1/inventory/low-stock") return envelope([inventory[0]]);
  if (pathname === "/api/v1/inventory" || pathname.startsWith("/api/v1/inventory?")) return envelope(inventory, { total: inventory.length, page: 1, perPage: 20 });
  if (pathname === "/api/v1/customers" || pathname.startsWith("/api/v1/customers?")) return envelope(customers, { total: customers.length, page: 1, perPage: 20 });
  if (pathname.startsWith("/api/v1/customers/") && pathname.endsWith("/purchases")) return envelope(sales, { total: sales.length, page: 1, perPage: 20 });
  if (pathname === "/api/v1/drafts" || pathname.startsWith("/api/v1/drafts?")) return envelope(drafts, { total: drafts.length, page: 1, perPage: 20 });
  if (pathname.startsWith("/api/v1/drafts/")) return envelope(method === "POST" ? drafts[0] : drafts[0]);
  return envelope([]);
}

function slugFor(route) {
  return route === "/" ? "root" : route.replace(/^\//, "").replaceAll("/", "-");
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
  });
}

async function waitForServer(url) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error("Vite preview did not start in time");
}

await run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], webRoot);
await mkdir(outputRoot, { recursive: true });
const preview = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "preview", "--", "--host", "127.0.0.1", "--port", String(port)], { cwd: webRoot, stdio: "ignore", shell: process.platform === "win32" });
try {
  await waitForServer(baseUrl);
  const browser = await chromium.launch({ headless: true });
  const routes = ["/", "/login", "/signup", "/2fa", "/today", "/sales", "/inventory", "/customers", "/reports", "/expenses", "/settings", "/settings/2fa", "/pos"];
  const sizes = [{ name: "360x800", width: 360, height: 800 }, { name: "1280x800", width: 1280, height: 800 }];
  const screenshots = [];
  for (const size of sizes) {
    for (const route of routes) {
      const page = await browser.newPage({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 1 });
      await page.route("**/api/v1/**", async (intercepted) => {
        const body = await responseFor(intercepted.request().url(), intercepted.request().method());
        await intercepted.fulfill({ status: 200, contentType: "application/json", body });
      });
      const filename = `${slugFor(route)}-${size.name}.png`;
      await page.goto(`${baseUrl}${route}`, { waitUntil: "networkidle" });
      await page.evaluate(() => document.fonts?.ready);
      await page.waitForTimeout(350);
      await page.screenshot({ path: path.join(outputRoot, filename), fullPage: false });
      screenshots.push({ route, size: size.name, filename });
      await page.close();
    }
  }
  await browser.close();
  const cards = screenshots.map(({ route, size, filename }) => `<a class="card" href="${filename}"><img src="${filename}" alt="${route} at ${size}"><span>${route} · ${size}</span></a>`).join("\n");
  await writeFile(path.join(outputRoot, "index.html"), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Gezi AI design review</title><style>body{margin:0;padding:32px;background:#f6f8f7;color:#101418;font:16px/1.4 Inter,Arial,sans-serif}h1{margin:0 0 8px;font-size:30px}p{margin:0 0 24px;color:#4a5560}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:20px}.card{display:block;padding:12px;border:1px solid #e2e8e5;border-radius:8px;background:#fff;color:#101418;text-decoration:none;box-shadow:0 1px 2px rgb(16 20 24 / .08),0 8px 24px rgb(16 20 24 / .06)}.card img{display:block;width:100%;height:auto;border:1px solid #e2e8e5;background:#f6f8f7}.card span{display:block;padding-top:10px;font-weight:700}</style></head><body><h1>Gezi AI · design review</h1><p>WP-32 seeded route captures · light theme · 360×800 and 1280×800 · generated ${new Date().toISOString()}</p><div class="grid">${cards}</div></body></html>`, "utf8");
} finally {
  preview.kill();
}