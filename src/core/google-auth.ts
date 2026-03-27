import { google } from "googleapis";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

const SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/tasks",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/spreadsheets",
];

function createOAuth2Client() {
  return new google.auth.OAuth2(
    config.GOOGLE_CLIENT_ID,
    config.GOOGLE_CLIENT_SECRET,
    config.GOOGLE_REDIRECT_URI,
  );
}

let _authClient: ReturnType<typeof createOAuth2Client> | null = null;

export function getGoogleAuth() {
  if (_authClient) return _authClient;

  if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_REFRESH_TOKEN) {
    logger.warn("Google OAuth2 not configured — Calendar/Gmail disabled");
    return null;
  }

  _authClient = createOAuth2Client();
  _authClient.setCredentials({ refresh_token: config.GOOGLE_REFRESH_TOKEN });
  return _authClient;
}

export function isGoogleConfigured(): boolean {
  return !!(config.GOOGLE_CLIENT_ID && config.GOOGLE_REFRESH_TOKEN);
}

export function getAuthUrl(): string {
  const client = createOAuth2Client();
  return client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
  });
}

export async function exchangeCode(code: string) {
  const client = createOAuth2Client();
  const { tokens } = await client.getToken(code);
  return tokens;
}

/** Create an OAuth2 client authenticated with a specific user's refresh token */
export function getUserGoogleAuth(refreshToken: string) {
  const client = createOAuth2Client();
  client.setCredentials({ refresh_token: refreshToken });
  return client;
}
