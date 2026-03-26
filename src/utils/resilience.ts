import { logger } from "./logger.js";

/**
 * Retry a function with exponential backoff.
 * Waits: 1s, 2s, 4s between retries.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxRetries = 3,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000;
        logger.warn({ attempt: attempt + 1, maxRetries, delay, label }, "Retrying after failure");
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

/**
 * Circuit breaker: tries primary, falls back to fallback on failure.
 * If primary fails 3 times in 5 minutes, switches to fallback for 5 minutes.
 */
const circuitState = new Map<string, { failures: number; openUntil: number }>();

export async function withFallback<T>(
  primary: () => Promise<T>,
  fallback: () => Promise<T>,
  label: string,
): Promise<T> {
  const state = circuitState.get(label) ?? { failures: 0, openUntil: 0 };

  // Circuit is open — use fallback directly
  if (Date.now() < state.openUntil) {
    logger.debug({ label }, "Circuit open, using fallback");
    return fallback();
  }

  try {
    const result = await primary();
    // Reset on success
    state.failures = 0;
    circuitState.set(label, state);
    return result;
  } catch (err) {
    state.failures++;
    if (state.failures >= 3) {
      state.openUntil = Date.now() + 5 * 60 * 1000; // Open for 5 minutes
      state.failures = 0;
      logger.warn({ label }, "Circuit breaker opened — switching to fallback for 5 minutes");
    }
    circuitState.set(label, state);
    logger.warn({ label, err: (err as Error).message }, "Primary failed, trying fallback");
    return fallback();
  }
}
