import { chromium } from "playwright";
import type { Browser } from "playwright";
import { getRedis } from "../utils/conversation-cache.js";
import { logger } from "../utils/logger.js";

const REDIS_SESSION_KEY = "browser:session_state";

let browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({ headless: true });
    logger.info("Playwright Chromium browser launched");
  }
  return browser;
}

/**
 * Loads saved browser session state from Redis.
 * Returns undefined if no session is saved (anonymous/public session).
 * Avoids large env vars that exceed Railway's 32KB limit.
 */
async function loadStorageState(): Promise<object | undefined> {
  const redis = getRedis();
  if (!redis) return undefined;
  try {
    const raw = await redis.get(REDIS_SESSION_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    logger.warn("Failed to load browser session state from Redis — using anonymous session");
  }
  return undefined;
}

/** Save browser session state to Redis (no TTL — persists until explicitly cleared) */
export async function saveSessionState(state: object): Promise<void> {
  const redis = getRedis();
  if (!redis) throw new Error("Redis non disponibile — impossibile salvare la sessione");
  await redis.set(REDIS_SESSION_KEY, JSON.stringify(state));
  logger.info("Browser session state saved to Redis");
}

export async function takeScreenshot(
  url: string,
  opts?: { fullPage?: boolean; width?: number; height?: number },
): Promise<Buffer> {
  const b = await getBrowser();
  const storageState = await loadStorageState();

  const context = await b.newContext({
    viewport: { width: opts?.width ?? 1280, height: opts?.height ?? 720 },
    ...(storageState ? { storageState: storageState as any } : {}),
  });
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });

    // Detect redirect to login/auth pages — inform user, don't crash
    const finalUrl = page.url();
    const isLoginPage =
      finalUrl.includes("accounts.google.com") ||
      finalUrl.includes("login.microsoftonline.com") ||
      finalUrl.includes("notion.so/login") ||
      finalUrl.includes("slack.com/signin") ||
      (finalUrl.includes("?next=") && finalUrl.includes("login"));
    if (isLoginPage) {
      throw new Error("La pagina richiede autenticazione. Per ora sono supportati solo URL pubblici.");
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
