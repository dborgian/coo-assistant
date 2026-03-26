import type { Context } from "grammy";
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

  // Send OAuth link
  const authUrl = getAuthUrl();

  await ctx.reply(
    "Benvenuto! Per usare questo bot devi autenticarti con il tuo account Google.\n\n" +
      "1. Clicca il link qui sotto\n" +
      "2. Autorizza l'accesso con il tuo account Google\n" +
      "3. Dopo l'autorizzazione verrai reindirizzato a una pagina che non carichera' (localhost) — e' normale\n" +
      "4. Copia il parametro 'code' dall'URL nella barra degli indirizzi e incollalo qui\n\n" +
      "L'URL sara' tipo:\nhttp://localhost:8080/oauth/callback?code=4/0XXXXX...\n\n" +
      "Copia tutto il valore dopo 'code=' e incollalo qui.",
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

  const authUrl = getAuthUrl();

  await ctx.reply(
    "Connetti il tuo account Google:\n\n" +
      "1. Clicca il link qui sotto\n" +
      "2. Autorizza l'accesso\n" +
      "3. Copia il parametro 'code' dall'URL e incollalo qui\n\n" +
      "L'URL dopo l'autorizzazione sara' tipo:\nhttp://localhost:8080/oauth/callback?code=4/0XXXXX...\n\n" +
      "Copia il valore dopo 'code='.",
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
