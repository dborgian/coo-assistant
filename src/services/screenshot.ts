import { chromium } from "playwright";
import type { Browser } from "playwright";
import { logger } from "../utils/logger.js";

let browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({ headless: true });
    logger.info("Playwright Chromium browser launched");
  }
  return browser;
}

export async function takeScreenshot(
  url: string,
  opts?: { fullPage?: boolean; width?: number; height?: number },
): Promise<Buffer> {
  const b = await getBrowser();
  const page = await b.newPage({
    viewport: { width: opts?.width ?? 1280, height: opts?.height ?? 720 },
  });
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });

    // Detect redirect to login/auth pages (Google, Notion, etc.)
    const finalUrl = page.url();
    const isLoginPage =
      finalUrl.includes("accounts.google.com") ||
      finalUrl.includes("login.microsoftonline.com") ||
      finalUrl.includes("notion.so/login") ||
      finalUrl.includes("slack.com/signin") ||
      (finalUrl.includes("?next=") && finalUrl.includes("login"));
    if (isLoginPage) {
      throw new Error(`La pagina richiede autenticazione — lo screenshot mostrerebbe solo la pagina di login. Usa gli strumenti specifici (Google Drive, Notion, ecc.) per accedere a contenuti protetti.`);
    }

    const buffer = await page.screenshot({
      fullPage: opts?.fullPage ?? false,
      type: "png",
    });
    return Buffer.from(buffer);
  } finally {
    await page.close();
  }
}

/** Graceful shutdown — call on process exit */
export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
}
