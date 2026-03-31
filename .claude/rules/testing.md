# Testing Rules

## Current State
No test framework configured yet. Tests are TODO.

## When Tests Are Added
- Use Vitest (preferred for TypeScript/Node.js)
- Test services independently with mocked DB/APIs
- Test AI tool handlers with mock responses
- Test cron job logic without actual scheduling
- Integration tests: verify bot commands produce expected output

## Manual Testing
- `npx tsc --noEmit` — must pass before any deploy
- Start bot: `npx tsx src/index.ts`
- Test slash commands in Slack: `/coo-dashboard`, `/coo-status`, `/coo-tasks`
- Test DM: message the bot directly in Slack
- Check Pino logs for errors
