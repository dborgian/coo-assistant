/**
 * Browser login script for private page screenshots.
 *
 * Opens a visible Chromium window so you can log into any site (Notion, Google, etc.),
 * then saves the session state directly to Redis — no env var, no file size limit.
 *
 * Run LOCALLY (requires a display — works on Windows or WSL with X11):
 *   npm run browser:login
 *
 * The session persists in Redis until cookies expire (usually weeks/months).
 * Re-run this script to refresh it.
 */

import { chromium } from "playwright";
import { createInterface } from "readline";
import Redis from "ioredis";
import { config as loadDotenv } from "dotenv";

loadDotenv();

const REDIS_SESSION_KEY_PREFIX = "browser:session_state";

// Parse --user <slack_member_id> from argv
const userArgIdx = process.argv.indexOf("--user");
const slackUserId = userArgIdx !== -1 ? process.argv[userArgIdx + 1] : undefined;
const redisKey = slackUserId ? `${REDIS_SESSION_KEY_PREFIX}:${slackUserId}` : REDIS_SESSION_KEY_PREFIX;

function waitForEnter(prompt: string): Promise<void> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => { rl.close(); resolve(); });
  });
}

(async () => {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    console.error("❌  REDIS_URL non trovato nel .env — impossibile salvare la sessione.");
    process.exit(1);
  }

  if (slackUserId) {
    console.log(`👤  Modalità per-utente: sessione salvata per Slack ID "${slackUserId}"`);
    console.log(`    Chiave Redis: ${redisKey}\n`);
  } else {
    console.log("🌐  Modalità condivisa: sessione salvata come fallback per tutti gli utenti.");
    console.log(`    Chiave Redis: ${redisKey}\n`);
  }

  console.log("🌐  Avvio Chromium con interfaccia grafica...");
  const browser = await chromium.launch({ headless: false, args: ["--start-maximized"] });
  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();
  await page.goto("https://www.notion.so");

  console.log("\n✅  Chromium aperto.");
  console.log("👉  Fai login su tutti i siti che vuoi (Notion, Google, etc.).");
  console.log("    Puoi navigare liberamente — la sessione viene salvata quando premi ENTER.\n");

  await waitForEnter("Premi ENTER quando hai finito di fare login...");

  console.log("\n💾  Estrazione e salvataggio sessione in Redis...");
  const state = await context.storageState();
  await browser.close();

  const redis = new Redis(redisUrl);
  await redis.set(redisKey, JSON.stringify(state));
  await redis.quit();

  console.log(`\n✅  Sessione salvata (${redisKey}): ${state.cookies.length} cookies, ${state.origins.length} origini.`);
  console.log("    Gli screenshot di pagine private funzioneranno fino alla scadenza dei cookies.");
  process.exit(0);
})();
