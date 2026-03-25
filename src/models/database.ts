import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { config } from "../config.js";
import * as schema from "./schema.js";
import { logger } from "../utils/logger.js";

const client = postgres(config.SUPABASE_DB_URL);
export const db = drizzle(client, { schema });

export async function initDb(): Promise<void> {
  await client`SELECT 1`;
  logger.info("Database connected (Supabase)");
}

export async function closeDb(): Promise<void> {
  await client.end();
}
