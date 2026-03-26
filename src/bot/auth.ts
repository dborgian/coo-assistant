import type { Context, NextFunction } from "grammy";
import { eq } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../models/database.js";
import { employees } from "../models/schema.js";
import { logger } from "../utils/logger.js";

export type AccessRole = "owner" | "admin" | "viewer";

export interface AuthUser {
  employeeId: string | null;
  role: AccessRole;
  name: string;
  telegramUserId: number;
}

// In-memory cache to avoid DB lookups on every message
const userCache = new Map<number, { user: AuthUser; cachedAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function clearAuthCache(): void {
  userCache.clear();
}

async function resolveUser(telegramId: number): Promise<AuthUser | null> {
  // Check cache first
  const cached = userCache.get(telegramId);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.user;
  }

  // Owner by TELEGRAM_OWNER_CHAT_ID (always has access, even without employee record)
  if (telegramId === config.TELEGRAM_OWNER_CHAT_ID) {
    // Still try to find employee record for the owner
    const [emp] = await db
      .select()
      .from(employees)
      .where(eq(employees.telegramUserId, telegramId))
      .limit(1);

    const user: AuthUser = {
      employeeId: emp?.id ?? null,
      role: "owner",
      name: emp?.name ?? "Owner",
      telegramUserId: telegramId,
    };
    userCache.set(telegramId, { user, cachedAt: Date.now() });
    return user;
  }

  // Lookup by telegramUserId in employees table
  const [emp] = await db
    .select()
    .from(employees)
    .where(eq(employees.telegramUserId, telegramId))
    .limit(1);

  if (!emp || !emp.isActive) return null;

  const role = (emp.accessRole as AccessRole) ?? "viewer";
  const user: AuthUser = {
    employeeId: emp.id,
    role,
    name: emp.name,
    telegramUserId: telegramId,
  };
  userCache.set(telegramId, { user, cachedAt: Date.now() });
  return user;
}

// Store auth user on context via a WeakMap keyed by context object
const authStore = new WeakMap<Context, AuthUser>();

export function getAuthUser(ctx: Context): AuthUser | undefined {
  return authStore.get(ctx);
}

export async function authMiddleware(ctx: Context, next: NextFunction): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await resolveUser(telegramId);
  if (!user) {
    // Allow /start through for unknown users (onboarding flow)
    const text = ctx.message && "text" in ctx.message ? (ctx.message.text ?? "") : "";
    if (text.startsWith("/start")) {
      await next();
      return;
    }

    // Allow text messages through if user is in onboarding (pasting OAuth code)
    const { isAwaitingOAuth } = await import("./onboarding.js");
    if (isAwaitingOAuth(telegramId)) {
      await next();
      return;
    }

    logger.debug({ telegramId }, "Unauthorized Telegram user attempted access");
    await ctx.reply(
      "Non sei autorizzato ad usare questo bot. Usa /start per registrarti.",
    ).catch(() => {});
    return;
  }

  authStore.set(ctx, user);
  await next();
}

export function requireRole(...roles: AccessRole[]) {
  return async (ctx: Context, next: NextFunction): Promise<void> => {
    const user = getAuthUser(ctx);
    if (!user || !roles.includes(user.role)) {
      await ctx.reply("Non hai i permessi per questo comando.").catch(() => {});
      return;
    }
    await next();
  };
}
