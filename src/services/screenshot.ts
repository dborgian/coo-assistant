import { chromium } from "playwright";
import type { Browser } from "playwright";
import { getRedis } from "../utils/conversation-cache.js";
import { logger } from "../utils/logger.js";

const REDIS_SESSION_KEY_PREFIX = "browser:session_state";

let browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
    logger.info("Playwright Chromium browser launched");
  }
  return browser;
}

/**
 * Loads saved browser session state from Redis.
 * Tries per-user key first (browser:session_state:{slackUserId}), then shared fallback.
 * Returns undefined if no session found (anonymous/public session).
 */
async function loadStorageState(slackUserId?: string): Promise<object | undefined> {
  const redis = getRedis();
  if (!redis) return undefined;
  try {
    // 1. Per-user session
    if (slackUserId) {
      const raw = await redis.get(`${REDIS_SESSION_KEY_PREFIX}:${slackUserId}`);
      if (raw) return JSON.parse(raw);
    }
    // 2. Shared fallback session
    const raw = await redis.get(REDIS_SESSION_KEY_PREFIX);
    if (raw) return JSON.parse(raw);
  } catch {
    logger.warn("Failed to load browser session state from Redis — using anonymous session");
  }
  return undefined;
}

/** Save browser session state to Redis (no TTL — persists until explicitly cleared) */
export async function saveSessionState(state: object, slackUserId?: string): Promise<void> {
  const redis = getRedis();
  if (!redis) throw new Error("Redis non disponibile — impossibile salvare la sessione");
  const key = slackUserId ? `${REDIS_SESSION_KEY_PREFIX}:${slackUserId}` : REDIS_SESSION_KEY_PREFIX;
  await redis.set(key, JSON.stringify(state));
  logger.info({ key }, "Browser session state saved to Redis");
}

export async function takeScreenshot(
  url: string,
  opts?: { fullPage?: boolean; width?: number; height?: number; slackUserId?: string },
): Promise<Buffer> {
  const b = await getBrowser();
  const storageState = await loadStorageState(opts?.slackUserId);

  const context = await b.newContext({
    viewport: { width: opts?.width ?? 1280, height: opts?.height ?? 720 },
    ...(storageState ? { storageState: storageState as any } : {}),
  });
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForLoadState("networkidle").catch(() => {});

    // Adaptive wait: check for meaningful content, retry up to 4x (max 8s)
    for (let attempt = 0; attempt < 4; attempt++) {
      const hasContent = await page.evaluate(() => {
        const body = document.body;
        if (!body) return false;
        const appRoot = body.querySelector("main, #app, #root, [role='main'], .app, article");
        return appRoot ? appRoot.scrollHeight > 100 : body.scrollHeight > 200;
      });
      if (hasContent) break;
      await page.waitForTimeout(2000);
    }

    // Wait for skeleton/loading indicators to disappear (Notion, Linear, etc.)
    await page.waitForFunction(() => {
      const skeletons = document.querySelectorAll(
        '[class*="skeleton"], [class*="loading"], [data-placeholder="true"], .shimmer'
      );
      return skeletons.length === 0;
    }, { timeout: 10_000 }).catch(() => {});

    // Extra buffer for secondary content (sidebar, database rows, images)
    await page.waitForTimeout(1500);

    // Detect redirect to login/auth pages — inform user, don't crash
    const finalUrl = page.url();
    const isLoginPage =
      finalUrl.includes("accounts.google.com") ||
      finalUrl.includes("login.microsoftonline.com") ||
      finalUrl.includes("notion.so/login") ||
      finalUrl.includes("slack.com/signin") ||
      finalUrl.includes("app.slack.com/ssb/signin") ||
      (finalUrl.includes("?next=") && finalUrl.includes("login"));
    if (isLoginPage) {
      const userHint = opts?.slackUserId
        ? `Esegui: npm run browser:login -- --user ${opts.slackUserId}`
        : "Esegui: npm run browser:login -- --user <tuo_slack_id>";
      throw new Error(`La pagina richiede autenticazione. Per abilitare screenshot di pagine private: ${userHint}`);
    }

    // Content check: if page body has less than 100 chars of text, likely not rendered
    const bodyText = await page.evaluate(() => document.body?.innerText?.trim() ?? "");
    if (bodyText.length < 100) {
      const userHint = opts?.slackUserId
        ? `Esegui: npm run browser:login -- --user ${opts.slackUserId}`
        : "Esegui: npm run browser:login -- --user <tuo_slack_id>";
      throw new Error(`La pagina sembra vuota o non caricata — probabilmente richiede autenticazione. ${userHint}`);
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
