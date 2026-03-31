/**
 * In-memory conversation history cache per chat Telegram.
 * TTL di 10 minuti — dopo l'inattivita il contesto scade e si riparte da zero.
 * Nessuna dipendenza esterna: sufficiente per un bot con pochi utenti.
 * Nota: la history si perde al riavvio del processo (accettabile).
 */

const TTL_MS = 10 * 60 * 1000; // 10 minuti
const MAX_ENTRIES = 6; // max 3 coppie user/assistant

interface ConversationEntry {
  role: "user" | "assistant";
  content: string;
}

interface ConversationSession {
  messages: ConversationEntry[];
  updatedAt: number;
}

const cache = new Map<number, ConversationSession>();

export function getConversationHistory(chatId: number): ConversationEntry[] {
  const session = cache.get(chatId);
  if (!session || Date.now() - session.updatedAt > TTL_MS) {
    cache.delete(chatId);
    return [];
  }
  return session.messages;
}

export function addToConversation(chatId: number, role: "user" | "assistant", content: string): void {
  let session = cache.get(chatId);
  if (!session || Date.now() - session.updatedAt > TTL_MS) {
    session = { messages: [], updatedAt: Date.now() };
  }
  session.messages.push({ role, content });
  if (session.messages.length > MAX_ENTRIES) {
    session.messages = session.messages.slice(-MAX_ENTRIES);
  }
  session.updatedAt = Date.now();
  cache.set(chatId, session);
}

export function clearConversation(chatId: number): void {
  cache.delete(chatId);
}

/** Chiamata dal scheduler periodicamente per liberare sessioni scadute. */
export function cleanExpiredSessions(): void {
  const now = Date.now();
  for (const [id, session] of cache) {
    if (now - session.updatedAt > TTL_MS) cache.delete(id);
  }
}
