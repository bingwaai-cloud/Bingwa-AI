import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(webRoot, "..");
const publicRoot = path.join(webRoot, "public");
const brandRoot = path.join(publicRoot, "brand");
const iconRoot = path.join(publicRoot, "icons");
const docsBrandRoot = path.join(repoRoot, "docs", "brand");

await mkdir(iconRoot, { recursive: true });
await mkdir(docsBrandRoot, { recursive: true });

const browser = await chromium.launch({ headless: true });

async function renderSvg(inputPath, outputPath, width, height) {
  const svg = await readFile(inputPath, "utf8");
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.setContent(`<html><body style="margin:0;width:${width}px;height:${height}px;background:transparent;display:grid;place-items:center">${svg}</body></html>`);
  await page.screenshot({ path: outputPath, omitBackground: true });
  await page.close();
}

const faviconSvg = path.join(brandRoot, "favicon.svg");
const conceptsSvg = path.join(docsBrandRoot, "gezi-logo-concepts.svg");
const faviconPng = path.join(publicRoot, "favicon.png");
const favicon32Png = path.join(publicRoot, "favicon-32.png");

await renderSvg(faviconSvg, faviconPng, 64, 64);
await renderSvg(faviconSvg, favicon32Png, 32, 32);
await renderSvg(faviconSvg, path.join(publicRoot, "apple-touch-icon.png"), 180, 180);
await renderSvg(faviconSvg, path.join(iconRoot, "icon-192.png"), 192, 192);
await renderSvg(faviconSvg, path.join(iconRoot, "icon-512.png"), 512, 512);
await renderSvg(faviconSvg, path.join(iconRoot, "icon-192-maskable.png"), 192, 192);
await renderSvg(faviconSvg, path.join(iconRoot, "icon-512-maskable.png"), 512, 512);
await renderSvg(faviconSvg, path.join(docsBrandRoot, "whatsapp-profile.png"), 640, 640);
await renderSvg(conceptsSvg, path.join(docsBrandRoot, "gezi-logo-concepts.png"), 1440, 760);

const png = await readFile(favicon32Png);
const ico = Buffer.alloc(6 + 16 + png.length);
ico.writeUInt16LE(0, 0);
ico.writeUInt16LE(1, 2);
ico.writeUInt16LE(1, 4);
ico.writeUInt8(32, 6);
ico.writeUInt8(32, 7);
ico.writeUInt8(0, 8);
ico.writeUInt8(0, 9);
ico.writeUInt16LE(1, 10);
ico.writeUInt16LE(32, 12);
ico.writeUInt32LE(png.length, 14);
ico.writeUInt32LE(22, 18);
png.copy(ico, 22);
await writeFile(path.join(publicRoot, "favicon.ico"), ico);

await browser.close();
