/**
 * Browser Login Script — saves authenticated session for the screenshot tool.
 *
 * Run LOCALLY (not on Railway, requires a display):
 *   npx tsx scripts/browser-login.ts
 *
 * After running:
 *   - Local dev: data/browser-storage.json is used automatically
 *   - Railway: copy the printed BROWSER_STORAGE_STATE value to Railway env vars
 */

import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import * as readline from "readline";

const OUTPUT_FILE = join(process.cwd(), "data", "browser-storage.json");

function waitForEnter(message: string): Promise<void> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(message, () => { rl.close(); resolve(); });
  });
}

(async () => {
  console.log("Launching browser for manual login...\n");

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  // Step 1: Google login
  await page.goto("https://accounts.google.com");
  await waitForEnter("Log in to Google in the browser window, then press ENTER here...");

  // Step 2: Notion login (optional)
  await page.goto("https://www.notion.so/login");
  await waitForEnter("Log in to Notion (if needed), then press ENTER here... (or just press ENTER to skip)");

  // Save session state
  const state = await context.storageState();
  mkdirSync(join(process.cwd(), "data"), { recursive: true });
  writeFileSync(OUTPUT_FILE, JSON.stringify(state, null, 2));

  const base64 = Buffer.from(JSON.stringify(state)).toString("base64");

  console.log(`\nSession saved to: ${OUTPUT_FILE}`);
  console.log("\nFor Railway, add this environment variable:");
  console.log("----------------------------------------");
  console.log(`BROWSER_STORAGE_STATE=${base64}`);
  console.log("----------------------------------------\n");

  await browser.close();
  process.exit(0);
})();
