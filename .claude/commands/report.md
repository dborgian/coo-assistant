# Generate Operations Report

Generate and review the daily operations report.

Steps:
1. Read `src/services/daily-reporter.ts` to understand report structure
2. Check `src/core/agent.ts` for the `generateDailyReport` method
3. Verify all data sources are connected (Calendar, Gmail, Slack, Notion)
4. Run `npx tsc --noEmit` to ensure no compilation errors
5. Test by running: `npx tsx -e "import { generateAndSendDailyReport } from './src/services/daily-reporter.js'"`
