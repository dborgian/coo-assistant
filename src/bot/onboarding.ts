import type { App } from "@slack/bolt";
import { eq } from "drizzle-orm";
import { google } from "googleapis";
import { config } from "../config.js";
import { db } from "../models/database.js";
import { employees } from "../models/schema.js";
import { logger } from "../utils/logger.js";
import { getAuthUrl, exchangeCode } from "../core/google-auth.js";
import { isGoogleConfigured } from "../core/google-auth.js";
import { sendSlackDM } from "../utils/notify.js";
import { clearSlackAuthCache } from "./slack-monitor.js";

/** Fetch the user's Google Calendar timezone setting */
async function getCalendarTimezone(auth: InstanceType<typeof google.auth.OAuth2>): Promise<string | null> {
  try {
    const calendar = google.calendar({ version: "v3", auth });
    const res = await calendar.settings.get({ setting: "timezone" });
    return res.data.value ?? null;
  } catch {
    return null;
  }
}

// Track Slack users awaiting OAuth redirect
const pendingOAuth = new Map<string, { createdAt: number }>();
const PENDING_TTL_MS = 10 * 60 * 1000; // 10 minutes

export function isAwaitingOAuth(slackUserId: string): boolean {
  const entry = pendingOAuth.get(slackUserId);
  if (!entry) return false;
  if (Date.now() - entry.createdAt > PENDING_TTL_MS) {
    pendingOAuth.delete(slackUserId);
    return false;
  }
  return true;
}

/**
 * Register /coo-connect-google and /coo-disconnect-google slash commands.
 * Called from slack-monitor.ts after slackApp is created.
 */
export function registerOAuthCommands(slackApp: App): void {
  slackApp.command("/coo-connect-google", async ({ command, ack, respond }) => {
    await ack();
    const slackUserId = command.user_id;

    if (!isGoogleConfigured()) {
      await respond("Google OAuth non e' configurato sul server.");
      return;
    }

    const authUrl = getAuthUrl(slackUserId);
    pendingOAuth.set(slackUserId, { createdAt: Date.now() });

    await respond(
      "Connetti il tuo account Google:\n\n" +
        "1. Clicca il link qui sotto\n" +
        "2. Autorizza l'accesso\n" +
        "3. Verrai reindirizzato automaticamente e l'account sara' connesso\n\n" +
        authUrl,
    );

    logger.info({ slackUserId }, "User started Google OAuth flow");
  });

  slackApp.command("/coo-disconnect-google", async ({ command, ack, respond }) => {
    await ack();
    const slackUserId = command.user_id;

    const [emp] = await db
      .select({ id: employees.id, googleRefreshToken: employees.googleRefreshToken })
      .from(employees)
      .where(eq(employees.slackMemberId, slackUserId))
      .limit(1);

    if (!emp) {
      await respond("Non sei registrato nel sistema.");
      return;
    }

    if (!emp.googleRefreshToken) {
      await respond("Nessun account Google collegato.");
      return;
    }

    // Best-effort revocation
    try {
      await fetch(`https://oauth2.googleapis.com/revoke?token=${emp.googleRefreshToken}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
    } catch {
      // ignore
    }

    await db
      .update(employees)
      .set({ googleRefreshToken: null, updatedAt: new Date() })
      .where(eq(employees.id, emp.id));

    clearSlackAuthCache(slackUserId);

    await respond("Account Google disconnesso. Usa /coo-connect-google per ricollegarlo.");
    logger.info({ slackUserId }, "User disconnected Google account");
  });
}

/**
 * Handle the OAuth callback from Google (called by the HTTP server).
 * state = Slack user ID (set as OAuth state parameter).
 */
export async function handleOAuthCallback(
  code: string,
  state: string,
): Promise<{ ok: boolean; message: string }> {
  const slackUserId = state;
  if (!slackUserId) {
    return { ok: false, message: "Stato non valido." };
  }

  if (!isAwaitingOAuth(slackUserId)) {
    return { ok: false, message: "Nessuna richiesta OAuth in corso per questo utente. Usa /coo-connect-google." };
  }

  try {
    const tokens = await exchangeCode(code);

    if (!tokens.refresh_token) {
      pendingOAuth.delete(slackUserId);
      return {
        ok: false,
        message: "Nessun refresh token ricevuto. Revoca l'accesso su myaccount.google.com/permissions e riprova.",
      };
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
    const timezone = await getCalendarTimezone(oauth2Client);

    const name = profile.name || "Utente";
    const email = profile.email ?? undefined;

    let matched = false;

    // 1. Try matching by email (pre-registered employee)
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
            slackMemberId: slackUserId,
            googleRefreshToken: tokens.refresh_token,
            googleEmail: email ?? null,
            timezone,
            updatedAt: new Date(),
          })
          .where(eq(employees.id, existing.id));
        matched = true;
        logger.info({ slackUserId, email, employeeId: existing.id, timezone }, "OAuth callback: linked existing employee");
      }
    }

    if (!matched) {
      // 2. Try matching by slackMemberId (reconnect case)
      const [existingBySlack] = await db
        .select()
        .from(employees)
        .where(eq(employees.slackMemberId, slackUserId))
        .limit(1);

      if (existingBySlack) {
        await db
          .update(employees)
          .set({ googleRefreshToken: tokens.refresh_token, timezone, updatedAt: new Date() })
          .where(eq(employees.id, existingBySlack.id));
        matched = true;
        logger.info({ slackUserId, timezone }, "OAuth callback: reconnected Google for existing employee");
      } else {
        // 3. Create new employee
        await db.insert(employees).values({
          name,
          email: email ?? null,
          googleEmail: email ?? null,
          slackMemberId: slackUserId,
          accessRole: "viewer",
          googleRefreshToken: tokens.refresh_token,
          timezone,
          isActive: true,
        });
        logger.info({ slackUserId, email, name, timezone }, "OAuth callback: created new employee");
      }
    }

    pendingOAuth.delete(slackUserId);
    clearSlackAuthCache(slackUserId);

    // Notify user via Slack DM
    const msg = matched
      ? `Autenticazione completata!\n\nNome: ${name}\n${email ? `Email: ${email}\n` : ""}Account Google connesso.\n\nUsa /coo-help per vedere i comandi disponibili.`
      : `Registrazione completata!\n\nNome: ${name}\n${email ? `Email: ${email}\n` : ""}\nUsa /coo-help per vedere i comandi disponibili.`;

    await sendSlackDM(slackUserId, msg).catch((err) => {
      logger.error({ err, slackUserId }, "Failed to send OAuth success message via Slack DM");
    });

    return { ok: true, message: "Autenticazione completata! Puoi tornare a Slack." };
  } catch (err) {
    logger.error({ err, slackUserId }, "OAuth callback failed");
    pendingOAuth.delete(slackUserId);
    return { ok: false, message: "Codice non valido o scaduto. Torna su Slack e riprova con /coo-connect-google." };
  }
}
