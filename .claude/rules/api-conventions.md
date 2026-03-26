# API & Integration Conventions

## Google APIs
- Auth via OAuth2 in `src/core/google-auth.ts`
- Always check `isGoogleConfigured()` before calling Google APIs
- Catch errors and return empty arrays/null — never crash

## Telegram Bot (grammY)
- Commands registered in `src/bot/commands.ts`
- Callbacks in `src/bot/callbacks.ts`
- Send AI-generated text WITHOUT parse_mode (avoids HTML/Markdown conflicts)
- Split messages > 4000 chars into chunks
- Use `config.TELEGRAM_OWNER_CHAT_ID` for founder notifications

## Slack
- Socket Mode via @slack/bolt
- Use `sendSlackMessage(channelId, text)` from `src/bot/slack-monitor.ts`
- Default channel: `config.SLACK_NOTIFICATIONS_CHANNEL`

## AI Agent Tools
- Define tools in `this.tools` array in `src/core/agent.ts`
- Implement handlers in `executeTool()` method
- Tool use loop: max 5 rounds per query
- Always confirm actions to user after execution

## Database
- Supabase PostgreSQL via shared pooler (port 6543)
- Drizzle ORM for queries
- Manual SQL for schema migrations (drizzle-kit push crashes with Supabase)
