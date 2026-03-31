# API & Integration Conventions

## Google APIs
- Auth via OAuth2 in `src/core/google-auth.ts`
- Always check `isGoogleConfigured()` before calling Google APIs
- Catch errors and return empty arrays/null — never crash

## Slack Bot (@slack/bolt)
- Socket Mode — no Request URL needed, works with Railway
- Slash commands registered in `src/bot/slack-commands.ts` via `registerSlashCommands()`
- Block Kit dashboard in `src/bot/slack-dashboard.ts` via `registerDashboardActions()`
- OAuth onboarding in `src/bot/onboarding.ts` via `registerOAuthCommands()`
- All commands registered from `startSlackMonitor()` in `src/bot/slack-monitor.ts`
- Notifications via `src/utils/notify.ts`: `sendOwnerNotification()`, `notifyAssigneeAndOwner()`, `sendEmployeeNotification()`
- HTML auto-converted to mrkdwn by `htmlToMrkdwn()` in `notify.ts`
- DM channel: `sendSlackDM(slackMemberId, text)` — opens conversation + posts
- Default notification channel: `config.SLACK_NOTIFICATIONS_CHANNEL`

## AI Agent Tools
- Define tools in `this.tools` array in `src/core/agent.ts`
- Implement handlers in `executeTool()` method
- Tool use loop: max 5 rounds per query
- Always confirm actions to user after execution

## Database
- Supabase PostgreSQL via shared pooler (port 6543)
- Drizzle ORM for queries
- Manual SQL for schema migrations (drizzle-kit push crashes with Supabase)
