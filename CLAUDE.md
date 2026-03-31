# COO Assistant — Team Instructions

## Project Overview
AI-powered COO assistant that orchestrates Google Workspace + Slack + Notion for startup operations. NOT a native tool — everything via external integrations.

## Tech Stack
- **Runtime:** Node.js 20+ / TypeScript (strict)
- **Bot:** @slack/bolt (Socket Mode) — slash commands + DMs + channel monitoring
- **AI:** @anthropic-ai/sdk (Claude Sonnet, 20+ AI tools)
- **DB:** PostgreSQL via Supabase (shared pooler) + Drizzle ORM
- **Integrations:** Google Calendar (R/W), Gmail, Drive, Slack, Notion
- **Scheduler:** node-cron (15 jobs)

## Code Conventions
- All source in `src/`, entry point `src/index.ts`
- Services in `src/services/` — one file per integration/feature
- Slack slash commands in `src/bot/slack-commands.ts`
- Slack dashboard (Block Kit) in `src/bot/slack-dashboard.ts`
- AI agent + tools in `src/core/agent.ts`
- Schema in `src/models/schema.ts` (Drizzle + PostgreSQL)
- Use Pino logger (`src/utils/logger.ts`), never console.log
- Zod for env validation in `src/config.ts`

## Database
- Supabase shared pooler (IPv4, port 6543) — NOT direct connection
- `drizzle-kit push` crashes with Supabase — use manual `ALTER TABLE` SQL
- Run migrations via: `node --input-type=module -e "import postgres from 'postgres'; ..."`

## Important Rules
- All features must use external integrations (Google, Slack, Notion, etc.)
- Do NOT build native tools (no custom calendar, no custom kanban, etc.)
- Notifications go via `src/utils/notify.ts` (Slack DMs) — not Telegram
- Google OAuth scope includes full calendar R/W — refresh token must match
- Italian language for bot responses, English for code/docs
