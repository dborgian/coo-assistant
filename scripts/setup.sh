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
  echo -e "${CYAN}${BOLD}======================================${NC}"
  echo -e "${CYAN}${BOLD}   COO Assistant — Setup${NC}"
  echo -e "${CYAN}${BOLD}======================================${NC}"
  echo ""
}

print_step() {
  echo -e "\n${GREEN}${BOLD}[$1/$TOTAL_STEPS] $2${NC}\n"
}

print_warn() {
  echo -e "${YELLOW}$1${NC}"
}

print_error() {
  echo -e "${RED}$1${NC}"
}

ask() {
  local prompt="$1"
  local var_name="$2"
  local default="$3"
  local value

  if [ -n "$default" ]; then
    read -rp "$(echo -e "${BOLD}$prompt${NC} [$default]: ")" value
    value="${value:-$default}"
  else
    while [ -z "$value" ]; do
      read -rp "$(echo -e "${BOLD}$prompt${NC}: ")" value
      if [ -z "$value" ]; then
        print_error "  This field is required."
      fi
    done
  fi

  eval "$var_name='$value'"
}

ask_optional() {
  local prompt="$1"
  local var_name="$2"
  local value
  read -rp "$(echo -e "${BOLD}$prompt${NC} (press Enter to skip): ")" value
  eval "$var_name='$value'"
}

confirm() {
  local prompt="$1"
  local answer
  read -rp "$(echo -e "${BOLD}$prompt${NC} [y/N]: ")" answer
  [[ "$answer" =~ ^[Yy]$ ]]
}

# ─────────────────────────────────────
print_header

# Check Node.js
if ! command -v node &> /dev/null; then
  print_error "Node.js is not installed."
  echo "Please install Node.js 20+ from https://nodejs.org"
  exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
  print_error "Node.js 20+ is required. You have $(node -v)."
  echo "Please update Node.js from https://nodejs.org"
  exit 1
fi

echo -e "${GREEN}Node.js $(node -v) detected${NC}"

# Check npm
if ! command -v npm &> /dev/null; then
  print_error "npm is not installed."
  exit 1
fi

# Determine total steps
TOTAL_STEPS=5

# ─────────────────────────────────────
print_step 1 "Installing dependencies"

if [ -d "node_modules" ]; then
  echo "node_modules already exists."
  if confirm "Re-install dependencies?"; then
    npm install
  fi
else
  npm install
fi

# ─────────────────────────────────────
print_step 2 "Telegram Bot configuration"

echo "You need a Telegram Bot Token from @BotFather."
echo "Open Telegram, search @BotFather, send /newbot and follow the instructions."
echo ""

ask "Telegram Bot Token" BOT_TOKEN
ask "Your Telegram Chat ID (get it from @userinfobot)" CHAT_ID

# ─────────────────────────────────────
print_step 3 "Anthropic API Key"

echo "You need an API key from https://console.anthropic.com"
echo ""

ask "Anthropic API Key" ANTHROPIC_KEY

# ─────────────────────────────────────
print_step 4 "Optional settings"

ask "Timezone" TIMEZONE "Europe/Rome"
ask "Daily report hour (0-23)" REPORT_HOUR "8"
ask "Daily report minute (0-59)" REPORT_MINUTE "0"

# GramJS
GRAMJS_API_ID="0"
GRAMJS_API_HASH=""
GRAMJS_SESSION=""

echo ""
echo "GramJS enables real-time monitoring of Telegram groups and DMs."
echo "It requires API credentials from https://my.telegram.org"
echo ""

if confirm "Enable chat monitoring (GramJS)?"; then
  ask "Telegram API ID (number from my.telegram.org)" GRAMJS_API_ID
  ask "Telegram API Hash (from my.telegram.org)" GRAMJS_API_HASH
  SETUP_GRAMJS=true
else
  SETUP_GRAMJS=false
fi

# ─────────────────────────────────────
print_step 5 "Creating .env file"

if [ -f ".env" ]; then
  if confirm ".env already exists. Overwrite it?"; then
    cp .env ".env.backup.$(date +%s)"
    echo "Existing .env backed up."
  else
    echo "Keeping existing .env. Setup complete."
    exit 0
  fi
fi

cat > .env << ENVEOF
# Telegram Bot
TELEGRAM_BOT_TOKEN=${BOT_TOKEN}
TELEGRAM_OWNER_CHAT_ID=${CHAT_ID}

# GramJS (userbot for monitoring group chats)
TELEGRAM_API_ID=${GRAMJS_API_ID}
TELEGRAM_API_HASH=${GRAMJS_API_HASH}
TELEGRAM_SESSION_STRING=${GRAMJS_SESSION}
MONITORED_CHAT_IDS=[]

# Anthropic (Claude API for AI reasoning)
ANTHROPIC_API_KEY=${ANTHROPIC_KEY}
AGENT_MODEL=claude-sonnet-4-20250514

# Google OAuth2 (for Calendar & Gmail — optional)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:8080/oauth/callback

# Kanbanchi (optional)
KANBANCHI_API_KEY=
KANBANCHI_BOARD_ID=

# Database
DATABASE_PATH=./data/coo.db

# Operations Config
DAILY_REPORT_HOUR=${REPORT_HOUR}
DAILY_REPORT_MINUTE=${REPORT_MINUTE}
TIMEZONE=${TIMEZONE}
CHAT_CHECK_INTERVAL_MINUTES=5
CALENDAR_CHECK_INTERVAL_MINUTES=15
ENVEOF

echo -e "${GREEN}.env created successfully${NC}"

# ─────────────────────────────────────
# GramJS login
if [ "$SETUP_GRAMJS" = true ]; then
  echo ""
  echo -e "${CYAN}${BOLD}Starting GramJS login...${NC}"
  echo "You'll be asked for your phone number and a verification code."
  echo ""
  npx tsx scripts/gramjs-login.ts

  echo ""
  echo "Copy the session string printed above and paste it here."
  ask "Session string" GRAMJS_SESSION

  # Update the session string in .env
  sed -i "s|^TELEGRAM_SESSION_STRING=.*|TELEGRAM_SESSION_STRING=${GRAMJS_SESSION}|" .env
  echo -e "${GREEN}Session string saved to .env${NC}"
fi

# ─────────────────────────────────────
echo ""
echo -e "${CYAN}${BOLD}======================================${NC}"
echo -e "${CYAN}${BOLD}   Setup complete!${NC}"
echo -e "${CYAN}${BOLD}======================================${NC}"
echo ""
echo -e "Start the bot with:"
echo ""
echo -e "  ${BOLD}npm run dev${NC}       Development mode (hot reload)"
echo -e "  ${BOLD}npm run build${NC}     Build for production"
echo -e "  ${BOLD}npm start${NC}         Run production build"
echo ""
echo -e "Then open Telegram and send ${BOLD}/start${NC} to your bot."
echo ""

if confirm "Start the bot now?"; then
  npm run dev
fi
