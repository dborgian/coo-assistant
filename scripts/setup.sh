#!/usr/bin/env bash
set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

print_header() {
  echo ""
  echo -e "${CYAN}${BOLD}══════════════════════════════════════${NC}"
  echo -e "${CYAN}${BOLD}   COO Assistant v1.0 — Setup${NC}"
  echo -e "${CYAN}${BOLD}══════════════════════════════════════${NC}"
  echo ""
}

print_step() {
  echo -e "\n${GREEN}${BOLD}[$1/$TOTAL_STEPS] $2${NC}\n"
}

print_warn() { echo -e "${YELLOW}$1${NC}"; }
print_error() { echo -e "${RED}$1${NC}"; }
print_ok() { echo -e "${GREEN}$1${NC}"; }

ask() {
  local prompt="$1" var_name="$2" default="$3" value
  if [ -n "$default" ]; then
    read -rp "$(echo -e "${BOLD}$prompt${NC} [$default]: ")" value
    value="${value:-$default}"
  else
    while [ -z "$value" ]; do
      read -rp "$(echo -e "${BOLD}$prompt${NC}: ")" value
      [ -z "$value" ] && print_error "  This field is required."
    done
  fi
  eval "$var_name='$value'"
}

ask_optional() {
  local prompt="$1" var_name="$2" value
  read -rp "$(echo -e "${BOLD}$prompt${NC} (Enter to skip): ")" value
  eval "$var_name='$value'"
}

confirm() {
  local answer
  read -rp "$(echo -e "${BOLD}$1${NC} [y/N]: ")" answer
  [[ "$answer" =~ ^[Yy]$ ]]
}

# ─────────────────────────────────────
print_header

# Check prerequisites
if ! command -v node &> /dev/null; then
  print_error "Node.js is not installed. Install Node.js 20+ from https://nodejs.org"
  exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
  print_error "Node.js 20+ required. You have $(node -v)."
  exit 1
fi
print_ok "✓ Node.js $(node -v)"

if ! command -v npm &> /dev/null; then
  print_error "npm is not installed."
  exit 1
fi
print_ok "✓ npm $(npm -v)"

TOTAL_STEPS=7

# ─── Step 1: Dependencies ───
print_step 1 "Installing dependencies"
if [ -d "node_modules" ]; then
  echo "node_modules exists."
  confirm "Re-install?" && npm install || echo "Skipping."
else
  npm install
fi

# ─── Step 2: Required config ───
print_step 2 "Required configuration"

echo "Create a Telegram bot via @BotFather → /newbot"
ask "Telegram Bot Token" BOT_TOKEN
ask "Your Telegram Chat ID (from @userinfobot)" CHAT_ID

echo ""
echo "Get an API key from https://console.anthropic.com"
ask "Anthropic API Key" ANTHROPIC_KEY

echo ""
echo "Create a Supabase project at https://supabase.com"
echo "Use the SHARED POOLER connection string (IPv4, port 6543)"
ask "Supabase Database URL" SUPABASE_URL

# ─── Step 3: Optional integrations ───
print_step 3 "Optional integrations"

# Google
GOOGLE_ID="" GOOGLE_SECRET="" GOOGLE_TOKEN=""
if confirm "Enable Google Workspace? (Calendar, Gmail, Drive, Sheets)"; then
  echo "Create OAuth2 credentials at https://console.cloud.google.com"
  echo "Enable: Calendar API, Gmail API, Drive API, Sheets API"
  ask "Google Client ID" GOOGLE_ID
  ask "Google Client Secret" GOOGLE_SECRET
  SETUP_GOOGLE=true
else
  SETUP_GOOGLE=false
fi

# Slack
SLACK_BOT="" SLACK_APP="" SLACK_SECRET="" SLACK_CHANNEL=""
if confirm "Enable Slack integration?"; then
  echo "Create a Slack app at https://api.slack.com/apps with Socket Mode"
  ask "Slack Bot Token (xoxb-...)" SLACK_BOT
  ask "Slack App Token (xapp-...)" SLACK_APP
  ask_optional "Slack Signing Secret" SLACK_SECRET
  ask_optional "Slack Notifications Channel ID" SLACK_CHANNEL
else
  echo "Skipping Slack."
fi

# Notion
NOTION_KEY="" NOTION_TASKS_DB="" NOTION_PROJECTS_DB=""
if confirm "Enable Notion integration?"; then
  echo "Create an integration at https://www.notion.so/my-integrations"
  ask "Notion API Key" NOTION_KEY
  ask_optional "Notion Tasks Database ID" NOTION_TASKS_DB
  ask_optional "Notion Projects Database ID" NOTION_PROJECTS_DB
else
  echo "Skipping Notion."
fi

# GramJS
GRAMJS_API_ID="0" GRAMJS_API_HASH="" GRAMJS_SESSION="" SETUP_GRAMJS=false
if confirm "Enable Telegram chat monitoring (GramJS)?"; then
  echo "Get credentials from https://my.telegram.org"
  ask "Telegram API ID" GRAMJS_API_ID
  ask "Telegram API Hash" GRAMJS_API_HASH
  SETUP_GRAMJS=true
fi

# ─── Step 4: Operations config ───
print_step 4 "Operations settings"
ask "Timezone" TIMEZONE "Europe/Rome"
ask "Daily report hour (0-23)" REPORT_HOUR "8"
ask "Daily report minute (0-59)" REPORT_MINUTE "0"

# ─── Step 5: Generate .env ───
print_step 5 "Creating .env file"

if [ -f ".env" ]; then
  if confirm ".env exists. Overwrite? (backup will be created)"; then
    cp .env ".env.backup.$(date +%s)"
    print_ok "Existing .env backed up."
  else
    echo "Keeping existing .env."
    # Still run migrations
    SKIP_ENV=true
  fi
fi

if [ "${SKIP_ENV:-}" != "true" ]; then
cat > .env << ENVEOF
# ═══ COO Assistant Configuration ═══

# Telegram Bot
TELEGRAM_BOT_TOKEN=${BOT_TOKEN}
TELEGRAM_OWNER_CHAT_ID=${CHAT_ID}

# GramJS (chat monitoring)
TELEGRAM_API_ID=${GRAMJS_API_ID}
TELEGRAM_API_HASH=${GRAMJS_API_HASH}
TELEGRAM_SESSION_STRING=${GRAMJS_SESSION}
MONITORED_CHAT_IDS=[]

# Anthropic Claude API
ANTHROPIC_API_KEY=${ANTHROPIC_KEY}
AGENT_MODEL=claude-sonnet-4-20250514

# Supabase PostgreSQL
SUPABASE_DB_URL=${SUPABASE_URL}
MESSAGE_RETENTION_DAYS=90

# Google OAuth2
GOOGLE_CLIENT_ID=${GOOGLE_ID}
GOOGLE_CLIENT_SECRET=${GOOGLE_SECRET}
GOOGLE_REDIRECT_URI=http://localhost:8080/oauth/callback
GOOGLE_REFRESH_TOKEN=${GOOGLE_TOKEN}
COO_DRIVE_FOLDER_ID=
DRIVE_DAILY_FOLDER_ID=
DRIVE_EMPLOYEE_FOLDER_ID=

# Slack
SLACK_BOT_TOKEN=${SLACK_BOT}
SLACK_APP_TOKEN=${SLACK_APP}
SLACK_SIGNING_SECRET=${SLACK_SECRET}
MONITORED_SLACK_CHANNELS=[]
SLACK_NOTIFICATIONS_CHANNEL=${SLACK_CHANNEL}

# Notion
NOTION_API_KEY=${NOTION_KEY}
NOTION_TASKS_DATABASE_ID=${NOTION_TASKS_DB}
NOTION_PROJECTS_DATABASE_ID=${NOTION_PROJECTS_DB}
NOTION_SYNC_INTERVAL_MINUTES=15

# Operations
DAILY_REPORT_HOUR=${REPORT_HOUR}
DAILY_REPORT_MINUTE=${REPORT_MINUTE}
TIMEZONE=${TIMEZONE}
CHAT_CHECK_INTERVAL_MINUTES=5
CALENDAR_CHECK_INTERVAL_MINUTES=15
EMAIL_CHECK_INTERVAL_MINUTES=10
ENVEOF

print_ok "✓ .env created"
fi

# ─── Step 6: Database migration ───
print_step 6 "Database setup"
echo "Running migrations..."
npx tsx scripts/db-migrate.ts
print_ok "✓ Database ready"

# ─── Step 7: Optional post-setup ───
print_step 7 "Final setup"

# GramJS login
if [ "$SETUP_GRAMJS" = true ]; then
  echo ""
  echo -e "${CYAN}Starting GramJS login...${NC}"
  npx tsx scripts/gramjs-login.ts
  echo ""
  ask "Paste the session string from above" GRAMJS_SESSION
  sed -i "s|^TELEGRAM_SESSION_STRING=.*|TELEGRAM_SESSION_STRING=${GRAMJS_SESSION}|" .env
  print_ok "✓ GramJS session saved"
fi

# Google OAuth
if [ "$SETUP_GOOGLE" = true ]; then
  echo ""
  echo -e "${CYAN}Starting Google OAuth...${NC}"
  echo "A browser window will open. Authorize all permissions."
  npx tsx scripts/google-oauth.ts
  echo ""
  ask "Paste the refresh token from above" GOOGLE_TOKEN
  sed -i "s|^GOOGLE_REFRESH_TOKEN=.*|GOOGLE_REFRESH_TOKEN=${GOOGLE_TOKEN}|" .env
  print_ok "✓ Google OAuth configured"
fi

# Test DB connection
echo ""
echo "Testing database connection..."
node --input-type=module -e "
import postgres from 'postgres';
const client = postgres(process.env.SUPABASE_DB_URL || '${SUPABASE_URL}');
await client\`SELECT 1\`;
console.log('✓ Database connection OK');
await client.end();
" 2>/dev/null && print_ok "✓ Database verified" || print_warn "⚠ Could not verify database connection"

# ─── Done ───
echo ""
echo -e "${CYAN}${BOLD}══════════════════════════════════════${NC}"
echo -e "${CYAN}${BOLD}   Setup complete!${NC}"
echo -e "${CYAN}${BOLD}══════════════════════════════════════${NC}"
echo ""
echo -e "  ${BOLD}npm run dev${NC}         Start in dev mode"
echo -e "  ${BOLD}npm run build${NC}       Build for production"
echo -e "  ${BOLD}npm start${NC}           Run production build"
echo -e "  ${BOLD}npm run db:migrate${NC}  Run database migrations"
echo -e "  ${BOLD}npm test${NC}            Run tests"
echo ""
echo -e "Open Telegram and send ${BOLD}/start${NC} to your bot."
echo ""
echo -e "Docs: ${BOLD}docs/USAGE.md${NC} | Demo: ${BOLD}docs/DEMO.md${NC}"
echo ""

if confirm "Start the bot now?"; then
  npm run dev
fi
