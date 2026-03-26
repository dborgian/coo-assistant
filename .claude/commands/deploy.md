# Deploy COO Assistant

Steps for deploying updates:

1. Run `npx tsc --noEmit` — must have zero errors
2. Check git status for uncommitted changes
3. Review changes with `git diff`
4. If DB schema changed: run manual SQL migrations on Supabase
5. If Google OAuth scope changed: regenerate refresh token via `npx tsx scripts/google-oauth.ts`
6. Commit changes with descriptive message
7. Push to remote
8. Restart the bot process on the server
