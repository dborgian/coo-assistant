import { chromium } from "playwright";
import type { Browser } from "playwright";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { logger } from "../utils/logger.js";

let browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({ headless: true });
    logger.info("Playwright Chromium browser launched");
  }
  return browser;
}

/**
 * Loads saved browser session state.
 * Priority: BROWSER_STORAGE_STATE env var (base64 JSON) → data/browser-storage.json file.
 * Returns undefined if neither is available (anonymous session).
 */
function loadStorageState(): object | undefined {
  const envVal = process.env.BROWSER_STORAGE_STATE;
  if (envVal) {
    try {
      return JSON.parse(Buffer.from(envVal, "base64").toString("utf-8"));
    } catch {
      logger.warn("BROWSER_STORAGE_STATE env var contains invalid JSON — ignored");
    }
  }
  const filePath = join(process.cwd(), "data", "browser-storage.json");
  if (existsSync(filePath)) {
    try {
      return JSON.parse(readFileSync(filePath, "utf-8"));
    } catch {
      logger.warn({ filePath }, "browser-storage.json is invalid JSON — ignored");
    }
  }
  return undefined;
}

export async function takeScreenshot(
  url: string,
  opts?: { fullPage?: boolean; width?: number; height?: number },
): Promise<Buffer> {
  const b = await getBrowser();
  const storageState = loadStorageState();

  const context = await b.newContext({
    viewport: { width: opts?.width ?? 1280, height: opts?.height ?? 720 },
    ...(storageState ? { storageState: storageState as any } : {}),
  });
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });

    // Detect redirect to login/auth pages (Google, Notion, Slack, etc.)
    const finalUrl = page.url();
    const isLoginPage =
      finalUrl.includes("accounts.google.com") ||
      finalUrl.includes("login.microsoftonline.com") ||
      finalUrl.includes("notion.so/login") ||
      finalUrl.includes("slack.com/signin") ||
      (finalUrl.includes("?next=") && finalUrl.includes("login"));
    if (isLoginPage) {
      const hint = storageState
        ? "La sessione salvata potrebbe essere scaduta. Riesegui: npx tsx scripts/browser-login.ts"
        : "Configura la sessione browser con: npx tsx scripts/browser-login.ts";
      throw new Error(`La pagina richiede autenticazione — screenshot non disponibile. ${hint}`);
    }

    const buffer = await page.screenshot({
      fullPage: opts?.fullPage ?? false,
      type: "png",
    });
    return Buffer.from(buffer);
  } finally {
    await context.close();
  }
}

/** Graceful shutdown — call on process exit */
export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
}
