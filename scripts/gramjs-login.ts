/**
 * GramJS Login Script
 *
 * Run this once to authenticate your Telegram account and get a session string.
 * Then paste the session string into your .env as TELEGRAM_SESSION_STRING.
 *
 * Usage: npx tsx scripts/gramjs-login.ts
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import dotenv from "dotenv";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

dotenv.config({ override: true });

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH ?? "";

if (!apiId || !apiHash) {
  console.error("Error: TELEGRAM_API_ID and TELEGRAM_API_HASH must be set in .env");
  console.error("Get them from https://my.telegram.org → API development tools");
  process.exit(1);
}

const rl = createInterface({ input: stdin, output: stdout });
const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
  connectionRetries: 5,
});

console.log("Logging in to Telegram...\n");

await client.start({
  phoneNumber: async () => rl.question("Enter your phone number (with country code, e.g. +39...): "),
  password: async () => rl.question("Enter your 2FA password (or press Enter if none): "),
  phoneCode: async () => rl.question("Enter the code you received on Telegram: "),
  onError: (err) => console.error("Login error:", err.message),
});

rl.close();

const sessionString = client.session.save() as unknown as string;

console.log("\n========================================");
console.log("Login successful!");
console.log("========================================");
console.log("\nCopy this session string into your .env file:\n");
console.log(`TELEGRAM_SESSION_STRING=${sessionString}`);
console.log("\n========================================");

await client.disconnect();
process.exit(0);
