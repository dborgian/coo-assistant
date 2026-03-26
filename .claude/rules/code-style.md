# Code Style Rules

- TypeScript strict mode, no `any` unless unavoidable
- Use `import type` for type-only imports
- Async/await, never raw Promises with .then()
- Use Pino logger, never console.log/error
- Services export standalone async functions (not classes), except `agent.ts` (COOAgent class)
- Drizzle ORM for all DB operations — no raw SQL except migrations
- Config via Zod-validated env vars in `src/config.ts`
- Error handling: try/catch with logger.error, return gracefully (no crashes)
- File naming: kebab-case (e.g. `task-escalation.ts`)
- Function naming: camelCase
- One service per file, one concern per service
