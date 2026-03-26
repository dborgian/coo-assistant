# Changelog — COO Assistant

## v1.0.0 — 2026-03-26

### Session Summary

Single-session major upgrade from dev prototype to production-ready AI COO platform.

#### Infrastructure
- **Supabase migration**: Switched from direct connection (IPv6) to shared pooler (IPv4, port 6543) — saves $4/month IPv4 add-on
- **Google OAuth**: Upgraded scope from `calendar.readonly` to full `calendar` + `spreadsheets` R/W
- **Google Sheets API**: Enabled in Google Cloud Console
- **Database**: 9 tables, 30+ columns on tasks table, all via manual SQL migrations (drizzle-kit push incompatible with Supabase)

#### Phase 1 — Motion-Lite Automations
- **Escalation system** (L0-L4): Progressive alerts via Telegram → Email → Slack → AI recommendation
- **Auto-prioritization**: Deadline-based priority upgrades (+ downgrades when deadline extended)
- **Recurring tasks**: Daily/weekly/monthly template generation
- **Workload tracking**: Employee metrics + workload score
- **Stale task detection**: Alert on tasks stuck 3+ days

#### Phase 2 — Advanced Motion Features
- **AI auto-scheduling**: Places tasks in Google Calendar free slots (per-employee via Google Workspace)
- **Task chunking**: Breaks 2h+ tasks into 90-min blocks with 15-min breaks
- **Dynamic rescheduling**: Priority/deadline changes trigger automatic reschedule
- **Task dependencies**: blockedBy with auto-unblock on completion
- **Capacity planning**: 5-day forecast (subtracts meeting hours from available time)
- **Smart daily agenda**: Personalized AI agenda per employee at 07:30
- **Proactive AI COO**: Risk detection 2x/day + weekly digest Friday 17:00

#### Phase 3 — Additional Integrations
- **Slack interactive buttons**: Complete/Snooze tasks directly from Slack notifications
- **Meeting → action items**: AI suggests tasks after calendar meetings end
- **Client weekly updates**: Automated status emails to clients every Monday
- **Notion two-way sync**: Bidirectional task sync (create, complete, archive, status, priority)
- **Google Sheets dashboard**: Weekly metrics export to shared spreadsheet

#### Phase 4 — Company Intelligence ("COO Ficcanaso")
- **Commitment tracker**: Detects promises in chat ("lo faccio io"), alerts if unfulfilled after 48h
- **Sentiment analysis**: Team morale scoring (-1 to +1) per employee, batch every 4h
- **Communication patterns**: Message counts, response times, active hours, silent employee detection
- **Decision log**: Auto-detects decisions in conversations ("abbiamo deciso...")
- **Knowledge base**: AI extracts company facts from conversations (clients, processes, lessons)
- **Topic extraction**: Trending topics + client mention frequency
- **Meeting intelligence**: Meeting hours, overload detection (>5h/day alert)

#### Phase 5 — Reliability & Polish
- **Retry logic**: Exponential backoff (3 retries) for all external API calls
- **Circuit breaker**: Falls back to alternative channel if primary fails
- **Notification batching**: Groups alerts into 5-min digests (reduces spam)
- **Sentiment data safety**: INSERT ON CONFLICT replaces DELETE+INSERT
- **Notion rate limiting**: Sync interval changed from 1min to 5min
- **Timezone fix**: Task due dates respect configured timezone (YYYY-MM-DDTHH:mm support)

#### Phase 6 — Production Readiness
- **Docker**: Dockerfile (multi-stage) + docker-compose.yml
- **PM2**: ecosystem.config.cjs for process management
- **Setup wizard**: Interactive `npm run setup` configures all integrations
- **DB migrations**: Idempotent `npm run db:migrate` script
- **Documentation**: README, SETUP.md, USAGE.md, DEMO.md fully rewritten
- **Testing**: 10 test suites, 61 tests (vitest)
- **Claude Code**: CLAUDE.md, commands/, rules/ project structure

#### Final Stats
- **28 AI tools** available via natural language
- **24+ cron jobs** running automated operations
- **9 integrations**: Google Calendar (R/W), Gmail, Drive, Sheets, Slack, Telegram, Notion, Supabase, Claude AI
- **9 database tables**: employees, clients, tasks, messageLogs, dailyReports, employeeMetrics, intelligenceEvents, sentimentScores, communicationStats
- **10 test suites**, 61 tests passing
