import type { Bot, Context } from "grammy";
import { eq } from "drizzle-orm";
import { google } from "googleapis";
import { config } from "../config.js";
import { db } from "../models/database.js";
import { employees } from "../models/schema.js";
import { logger } from "../utils/logger.js";
import { getAuthUrl, exchangeCode } from "../core/google-auth.js";
import { isGoogleConfigured } from "../core/google-auth.js";
import { clearAuthCache } from "./auth.js";

// Track users awaiting OAuth code paste
const pendingOAuth = new Map<number, { createdAt: number }>();
const PENDING_TTL_MS = 10 * 60 * 1000; // 10 minutes

export function isAwaitingOAuth(telegramId: number): boolean {
  const entry = pendingOAuth.get(telegramId);
  if (!entry) return false;
  if (Date.now() - entry.createdAt > PENDING_TTL_MS) {
    pendingOAuth.delete(telegramId);
    return false;
  }
  return true;
}

export async function handleFirstStart(ctx: Context): Promise<boolean> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return false;

  // Check if user already exists in DB
  const [existing] = await db
    .select()
    .from(employees)
    .where(eq(employees.telegramUserId, telegramId))
    .limit(1);

  if (existing) return false; // Not a first-time user

  if (!isGoogleConfigured()) {
    // No Google OAuth configured — create employee without Google auth
    await createEmployee(ctx);
    await ctx.reply(
      "Registrazione completata! Google OAuth non e' configurato, quindi l'autenticazione Google e' stata saltata.\n\n" +
        "Usa /help per vedere i comandi disponibili.",
    );
    return true;
  }

  // Send OAuth link with state param for automatic callback
  const authUrl = getAuthUrl(String(telegramId));

  await ctx.reply(
    "Benvenuto! Per usare questo bot devi autenticarti con il tuo account Google.\n\n" +
      "1. Clicca il link qui sotto\n" +
      "2. Autorizza l'accesso con il tuo account Google\n" +
      "3. Verrai reindirizzato automaticamente e la registrazione sara' completata\n\n" +
      "Se qualcosa non funziona, puoi anche incollare qui il codice dall'URL di redirect.",
  );
  await ctx.reply(authUrl);

  pendingOAuth.set(telegramId, { createdAt: Date.now() });
  logger.info({ telegramId, username: ctx.from?.username }, "First-time user started OAuth flow");

  return true;
}

export async function handleOAuthCode(ctx: Context): Promise<boolean> {
  const telegramId = ctx.from?.id;
  if (!telegramId || !isAwaitingOAuth(telegramId)) return false;

  const text = ctx.message && "text" in ctx.message ? ctx.message.text?.trim() : "";
  if (!text) return false;

  // Clean up the code — user might paste full URL or just the code
  let code = text;
  if (code.includes("code=")) {
    const match = code.match(/code=([^&\s]+)/);
    if (match) code = match[1];
  }

  // URL-decode the code (browser might encode it)
  try {
    code = decodeURIComponent(code);
  } catch {
    // ignore decode errors
  }

  await ctx.reply("Verifico il codice...");

  try {
    const tokens = await exchangeCode(code);

    if (!tokens.refresh_token) {
      await ctx.reply(
        "Non ho ricevuto un refresh token. Prova a revocare l'accesso su https://myaccount.google.com/permissions e rifai /start.",
      );
      pendingOAuth.delete(telegramId);
      return true;
    }

    // Get user profile from Google
    const oauth2Client = new google.auth.OAuth2(
      config.GOOGLE_CLIENT_ID,
      config.GOOGLE_CLIENT_SECRET,
      config.GOOGLE_REDIRECT_URI,
    );
    oauth2Client.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
    const { data: profile } = await oauth2.userinfo.get();

    const name = profile.name || ctx.from?.first_name || "Utente";
    const email = profile.email ?? undefined;
    const username = ctx.from?.username ?? null;

    // Check if an employee with this email already exists (pre-registered by admin)
    let matched = false;
    if (email) {
      const [existing] = await db
        .select()
        .from(employees)
        .where(eq(employees.email, email))
        .limit(1);

      if (existing) {
        // Link existing employee to this Telegram user
        await db
          .update(employees)
          .set({
            telegramUserId: telegramId,
            telegramUsername: username,
            googleRefreshToken: tokens.refresh_token,
            updatedAt: new Date(),
          })
          .where(eq(employees.id, existing.id));
        matched = true;

        logger.info(
          { telegramId, email, employeeId: existing.id },
          "Linked existing employee to Telegram user via email match",
        );
      }
    }

    if (!matched) {
      await createEmployee(ctx, {
        name,
        email,
        googleRefreshToken: tokens.refresh_token,
      });
    }

    pendingOAuth.delete(telegramId);
    clearAuthCache();

    await ctx.reply(
      `Autenticazione completata!\n\n` +
        `Nome: ${name}\n` +
        (email ? `Email: ${email}\n` : "") +
        (matched ? `(Account collegato al tuo profilo esistente)\n` : "") +
        `\nUsa /help per vedere i comandi disponibili.`,
    );

    logger.info({ telegramId, email, name, matched }, "First-time user completed OAuth onboarding");
    return true;
  } catch (err) {
    logger.error({ err, telegramId }, "OAuth code exchange failed");
    await ctx.reply(
      "Codice non valido o scaduto. Riprova con /start per generare un nuovo link.",
    );
    pendingOAuth.delete(telegramId);
    return true;
  }
}

export async function handleConnectGoogle(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  if (!isGoogleConfigured()) {
    await ctx.reply("Google OAuth non e' configurato sul server.");
    return;
  }

  const authUrl = getAuthUrl(String(telegramId));

  await ctx.reply(
    "Connetti il tuo account Google:\n\n" +
      "1. Clicca il link qui sotto\n" +
      "2. Autorizza l'accesso\n" +
      "3. Verrai reindirizzato automaticamente e l'account sara' connesso\n\n" +
      "Se qualcosa non funziona, puoi anche incollare qui il codice dall'URL di redirect.",
  );
  await ctx.reply(authUrl);

  pendingOAuth.set(telegramId, { createdAt: Date.now() });
}

export async function handleConnectGoogleCode(ctx: Context): Promise<boolean> {
  const telegramId = ctx.from?.id;
  if (!telegramId || !isAwaitingOAuth(telegramId)) return false;

  const text = ctx.message && "text" in ctx.message ? ctx.message.text?.trim() : "";
  if (!text) return false;

  let code = text;
  if (code.includes("code=")) {
    const match = code.match(/code=([^&\s]+)/);
    if (match) code = match[1];
  }
  try {
    code = decodeURIComponent(code);
  } catch {
    // ignore
  }

  await ctx.reply("Verifico il codice...");

  try {
    const tokens = await exchangeCode(code);

    if (!tokens.refresh_token) {
      await ctx.reply(
        "Non ho ricevuto un refresh token. Prova a revocare l'accesso su https://myaccount.google.com/permissions e rifai /connect_google.",
      );
      pendingOAuth.delete(telegramId);
      return true;
    }

    // Update existing employee record
    await db
      .update(employees)
      .set({ googleRefreshToken: tokens.refresh_token, updatedAt: new Date() })
      .where(eq(employees.telegramUserId, telegramId));

    pendingOAuth.delete(telegramId);
    clearAuthCache();

    await ctx.reply("Account Google connesso con successo!");
    logger.info({ telegramId }, "User reconnected Google account");
    return true;
  } catch (err) {
    logger.error({ err, telegramId }, "OAuth reconnect code exchange failed");
    await ctx.reply(
      "Codice non valido o scaduto. Riprova con /connect_google.",
    );
    pendingOAuth.delete(telegramId);
    return true;
  }
}

/**
 * Handle the OAuth callback from Google (called by the HTTP server).
 * Exchanges the code, creates/links the employee, and notifies via Telegram.
 */
export async function handleOAuthCallback(
  code: string,
  state: string,
  bot: Bot,
): Promise<{ ok: boolean; message: string }> {
  const telegramId = Number(state);
  if (!telegramId || Number.isNaN(telegramId)) {
    return { ok: false, message: "Stato non valido." };
  }

  if (!isAwaitingOAuth(telegramId)) {
    return { ok: false, message: "Nessuna richiesta OAuth in corso per questo utente. Usa /start nel bot." };
  }

  try {
    const tokens = await exchangeCode(code);

    if (!tokens.refresh_token) {
      pendingOAuth.delete(telegramId);
      return { ok: false, message: "Nessun refresh token ricevuto. Revoca l'accesso su myaccount.google.com/permissions e riprova." };
    }

    // Get user profile from Google
    const oauth2Client = new google.auth.OAuth2(
      config.GOOGLE_CLIENT_ID,
      config.GOOGLE_CLIENT_SECRET,
      config.GOOGLE_REDIRECT_URI,
    );
    oauth2Client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
    const { data: profile } = await oauth2.userinfo.get();

    const name = profile.name || "Utente";
    const email = profile.email ?? undefined;

    // Check if employee with this email already exists
    let matched = false;
    if (email) {
      const [existing] = await db
        .select()
        .from(employees)
        .where(eq(employees.email, email))
        .limit(1);

      if (existing) {
        await db
          .update(employees)
          .set({
            telegramUserId: telegramId,
            googleRefreshToken: tokens.refresh_token,
            updatedAt: new Date(),
          })
          .where(eq(employees.id, existing.id));
        matched = true;
        logger.info({ telegramId, email, employeeId: existing.id }, "OAuth callback: linked existing employee");
      }
    }

    if (!matched) {
      // Check if employee already exists by telegramId (reconnect case)
      const [existingByTg] = await db
        .select()
        .from(employees)
        .where(eq(employees.telegramUserId, telegramId))
        .limit(1);

      if (existingByTg) {
        await db
          .update(employees)
          .set({ googleRefreshToken: tokens.refresh_token, updatedAt: new Date() })
          .where(eq(employees.id, existingByTg.id));
        matched = true;
        logger.info({ telegramId }, "OAuth callback: reconnected Google for existing employee");
      } else {
        await db.insert(employees).values({
          name,
          email: email ?? null,
          telegramUserId: telegramId,
          accessRole: "viewer",
          googleRefreshToken: tokens.refresh_token,
          isActive: true,
        });
        logger.info({ telegramId, email, name }, "OAuth callback: created new employee");
      }
    }

    pendingOAuth.delete(telegramId);
    clearAuthCache();

    // Notify user via Telegram
    const msg = matched
      ? `Autenticazione completata!\n\nNome: ${name}\n${email ? `Email: ${email}\n` : ""}Account Google connesso.\n\nUsa /help per vedere i comandi disponibili.`
      : `Registrazione completata!\n\nNome: ${name}\n${email ? `Email: ${email}\n` : ""}\nUsa /help per vedere i comandi disponibili.`;

    try {
      await bot.api.sendMessage(telegramId, msg);
    } catch (err) {
      logger.error({ err, telegramId }, "Failed to send OAuth success message via Telegram");
    }

    return { ok: true, message: "Autenticazione completata! Puoi tornare a Telegram." };
  } catch (err) {
    logger.error({ err, telegramId }, "OAuth callback failed");
    pendingOAuth.delete(telegramId);
    return { ok: false, message: "Codice non valido o scaduto. Torna su Telegram e riprova con /start." };
  }
}

async function createEmployee(
  ctx: Context,
  extra?: { name?: string; email?: string; googleRefreshToken?: string },
): Promise<void> {
  const telegramId = ctx.from!.id;
  const username = ctx.from?.username ?? null;

  await db.insert(employees).values({
    name: extra?.name || ctx.from?.first_name || "Utente",
    email: extra?.email ?? null,
    telegramUserId: telegramId,
    telegramUsername: username,
    accessRole: "viewer",
    googleRefreshToken: extra?.googleRefreshToken ?? null,
    isActive: true,
  });
}
