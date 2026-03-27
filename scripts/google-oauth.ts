/**
 * Google OAuth2 Login Script
 *
 * Starts a local server, opens the auth URL, and captures the code automatically.
 *
 * Usage: npx tsx scripts/google-oauth.ts
 */

import dotenv from "dotenv";
dotenv.config({ override: true });

import { createServer } from "node:http";
import { URL } from "node:url";
import { google } from "googleapis";

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
const redirectUri = process.env.GOOGLE_REDIRECT_URI || "http://localhost:8080/oauth/callback";

if (!clientId || !clientSecret) {
  console.error("Error: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env");
  process.exit(1);
}

const SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/tasks",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/spreadsheets",
];

const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: "offline",
  scope: SCOPES,
  prompt: "consent",
});

// Parse port from redirect URI
const port = new URL(redirectUri).port || "8080";
const path = new URL(redirectUri).pathname;

// Start local server to catch the callback
const server = createServer(async (req, res) => {
  if (!req.url?.startsWith(path)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const url = new URL(req.url, `http://localhost:${port}`);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<h1>Authorization failed</h1><p>${error}</p><p>You can close this tab.</p>`);
    console.error(`\nAuthorization failed: ${error}`);
    server.close();
    process.exit(1);
  }

  if (!code) {
    res.writeHead(400);
    res.end("No code received");
    return;
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<h1>Authorization successful!</h1><p>You can close this tab and go back to the terminal.</p>");

    console.log("\n========================================");
    console.log("Authorization successful!");
    console.log("========================================\n");

    if (tokens.refresh_token) {
      console.log("Copy this into your .env file:\n");
      console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
    } else {
      console.log("No refresh_token received.");
      console.log("Try revoking access at https://myaccount.google.com/permissions and re-run.");
    }

    console.log("\n========================================");
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/html" });
    res.end("<h1>Token exchange failed</h1><p>Check the terminal for details.</p>");
    console.error("\nToken exchange failed:", err);
  }

  server.close();
  process.exit(0);
});

server.listen(Number(port), () => {
  console.log(`\nLocal server listening on port ${port}...`);
  console.log("\nOpen this URL in your browser:\n");
  console.log(authUrl);
  console.log("\nWaiting for authorization...");
});
