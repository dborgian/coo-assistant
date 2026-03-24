# COO Assistant — Setup Guide

This guide walks you through setting up the COO Assistant on your machine.

## Prerequisites

- **Node.js 20+** — Download from [nodejs.org](https://nodejs.org)
- **Telegram account** — For both the bot and chat monitoring
- **Anthropic API key** — From [console.anthropic.com](https://console.anthropic.com)

## Step 1: Install

```bash
git clone https://github.com/dborgian/coo-assistant.git
cd coo-assistant
npm install
```

## Step 2: Create Telegram Bot

1. Open Telegram and search for **@BotFather**
2. Send `/newbot`
3. Choose a name and username (must end with `bot`)
4. Copy the **bot token** you receive

## Step 3: Get your Chat ID

1. Open Telegram and search for **@userinfobot**
2. Send `/start`
3. Copy your **numeric ID**

## Step 4: Get Anthropic API Key

1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Navigate to **API Keys**
3. Create a new key and copy it

## Step 5: Configure .env

```bash
cp .env.example .env
```

Edit `.env` and fill in your values:

| Variable | Where to get it |
|----------|----------------|
| `TELEGRAM_BOT_TOKEN` | From @BotFather (Step 2) |
| `TELEGRAM_OWNER_CHAT_ID` | From @userinfobot (Step 3) |
| `ANTHROPIC_API_KEY` | From Anthropic console (Step 4) |
| `TIMEZONE` | Your timezone, e.g. `Europe/Rome`, `America/New_York` |
| `DAILY_REPORT_HOUR` | Hour for the daily report (24h format, default: 8) |

The remaining variables are optional and can be configured later.

## Step 6: Start the bot

```bash
# Development mode (with hot reload)
npm run dev

# Or production mode
npm run build
npm start
```

Open Telegram, search for your bot by username, and send `/start`.

## Step 7 (Optional): Enable Chat Monitoring

Chat monitoring uses GramJS to log into your personal Telegram account and monitor group chats in real-time. It classifies message urgency with AI and notifies you when something needs attention.

### 7a. Get Telegram API credentials

1. Go to [my.telegram.org](https://my.telegram.org)
2. Log in with your phone number
3. Click **API development tools**
4. Create an app (any name/description)
5. Copy **App api_id** and **App api_hash**

### 7b. Add to .env

```env
TELEGRAM_API_ID=12345678
TELEGRAM_API_HASH=your-api-hash-here
```

### 7c. Run the login script

```bash
npm run gramjs:login
```

This will ask for:
- Your **phone number** (with country code, e.g. `+39333...`)
- The **verification code** sent to your Telegram
- Your **2FA password** (if enabled, otherwise press Enter)

After login, the script prints a **session string**. Copy it into `.env`:

```env
TELEGRAM_SESSION_STRING=the-long-session-string
```

### 7d. Configure monitored chats

To monitor specific group chats, add their IDs to `.env`:

```env
MONITORED_CHAT_IDS=[-1001234567890,-1009876543210]
```

To find a group's chat ID, you can use **@raw_data_bot** — add it to the group, it will print the chat ID, then remove it.

If `MONITORED_CHAT_IDS` is empty (`[]`), all incoming messages will be monitored.

### 7e. Restart the bot

```bash
npm run dev
```

You should see "Chat monitoring active" in the logs.

## Step 8 (Optional): Google Calendar & Gmail

*Coming soon — requires Google Cloud OAuth2 setup.*

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Bot doesn't respond | Check `TELEGRAM_BOT_TOKEN` is correct. Make sure you sent `/start` |
| Bot responds to `/start` but not to messages | Check `ANTHROPIC_API_KEY` is valid and has credits |
| Bot ignores you | Your Chat ID doesn't match `TELEGRAM_OWNER_CHAT_ID` — the bot only responds to the owner |
| GramJS login fails | Double-check `TELEGRAM_API_ID` and `TELEGRAM_API_HASH`. Try again in a few minutes |
| "SESSION_EXPIRED" error | Re-run `npm run gramjs:login` to get a new session string |
| Daily report not sending | Check `TIMEZONE`, `DAILY_REPORT_HOUR`, and `DAILY_REPORT_MINUTE` in `.env` |

## Available Commands

| Command | Description |
|---------|-------------|
| `/start` | Initialize the bot |
| `/status` | Operations overview |
| `/report` | Generate AI-powered operations report |
| `/tasks` | List active tasks (`/tasks overdue` for overdue only) |
| `/remind [person] [task]` | Set a reminder |
| `/add_employee [name] [email] [role]` | Add team member |
| `/add_client [name] [company] [email]` | Add client |
| `/monitor add/list` | Configure chat monitoring |
| `/help` | Full command reference |
| Any text message | Ask the COO assistant anything |
