/**
 * Company Brain — persistent knowledge store for the COO Assistant.
 *
 * Three-tier memory stored in Redis + PostgreSQL:
 *   brain:meetings:recent   — last 20 processed meetings (30 days TTL)
 *   brain:decisions:open    — open decisions awaiting follow-up (60 days TTL)
 *   brain:facts:company     — stable company facts extracted from meetings (1 year TTL)
 *
 * The brain context is injected into every agent query so the AI is
 * always aware of recent decisions, ongoing work, and team/project facts.
 */
import { desc, eq } from "drizzle-orm";
import { agent } from "../core/agent.js";
import { db } from "../models/database.js";
import { intelligenceEvents } from "../models/schema.js";
import { getRedis } from "../utils/conversation-cache.js";
import { logger } from "../utils/logger.js";

// --- Redis keys & TTLs ---
const MEETINGS_KEY = "brain:meetings:recent";
const DECISIONS_KEY = "brain:decisions:open";
const FACTS_KEY = "brain:facts:company";
const TTL_MEETINGS  = 30  * 86400;
const TTL_DECISIONS = 60  * 86400;
const TTL_FACTS     = 365 * 86400;

// --- Types ---
export interface BrainMeeting {
  title: string;
  date: string;
  attendees: string[];
  summary: string;
  keyDecisions: string[];
  actionItems: Array<{ title: string; assignee?: string; dueDate?: string; priority?: string }>;
  openQuestions: string[];
  processedAt: string;
}

export interface OpenDecision {
  decision: string;
  meeting: string;
  date: string;
}

export interface CompanyFact {
  fact: string;
  category: "team" | "project" | "client" | "process" | "decision";
  extractedFrom: string;
  date: string;
}

// --- Internal helpers ---
async function rGet(key: string): Promise<string | null> {
  const redis = getRedis();
  if (!redis) return null;
  try { return await redis.get(key); } catch { return null; }
}

async function rSet(key: string, value: string, ttl: number): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try { await redis.set(key, value, "EX", ttl); } catch { /* silent */ }
}

// --- Public API ---

/**
 * Save a processed meeting into the brain.
 * Call this immediately after every meeting is processed.
 */
export async function feedMeetingToBrain(
  title: string,
  date: string,
  attendees: string[],
  summary: string,
  keyDecisions: string[],
  actionItems: Array<{ title: string; assignee?: string; dueDate?: string; priority?: string }>,
  openQuestions: string[],
): Promise<void> {
  const meeting: BrainMeeting = {
    title, date, attendees, summary, keyDecisions, actionItems, openQuestions,
    processedAt: new Date().toISOString(),
  };

  // --- Redis: prepend to meetings list ---
  const raw = await rGet(MEETINGS_KEY);
  const meetings: BrainMeeting[] = raw ? JSON.parse(raw) : [];
  meetings.unshift(meeting);
  if (meetings.length > 20) meetings.splice(20);
  await rSet(MEETINGS_KEY, JSON.stringify(meetings), TTL_MEETINGS);

  // --- Redis: add open decisions ---
  if (keyDecisions.length > 0) {
    const rawD = await rGet(DECISIONS_KEY);
    const decisions: OpenDecision[] = rawD ? JSON.parse(rawD) : [];
    for (const d of keyDecisions) {
      decisions.unshift({ decision: d, meeting: title, date });
    }
    if (decisions.length > 50) decisions.splice(50);
    await rSet(DECISIONS_KEY, JSON.stringify(decisions), TTL_DECISIONS);
  }

  // --- PostgreSQL: store meeting as intelligence event ---
  await db.insert(intelligenceEvents).values({
    type: "meeting_notes",
    content: `${title}: ${summary.slice(0, 200)}`,
    status: "active",
    metadata: { title, date, attendees, keyDecisions, actionItemCount: actionItems.length },
  }).catch((err) => logger.warn({ err }, "Failed to persist meeting to DB"));

  logger.info({ title, decisions: keyDecisions.length, actions: actionItems.length }, "Meeting fed to brain");
}

/**
 * Extract stable company facts from meeting content via Claude.
 * Fire-and-forget — call after feedMeetingToBrain.
 */
export async function extractAndSaveFacts(
  docContent: string,
  meetingTitle: string,
  meetingDate: string,
): Promise<void> {
  const prompt = `Analizza queste note di meeting ed estrai FATTI AZIENDALI STABILI — informazioni vere nel tempo, utili per capire l'azienda, il team e i progetti.

CATEGORIE:
- team: chi fa cosa, responsabilità, ruoli, skills
- project: progetti in corso, tecnologie scelte, obiettivi, milestone
- client: clienti, esigenze, preferenze, contratti
- process: decisioni strutturali, processi aziendali, regole operative
- decision: scelte strategiche importanti con impatto a lungo termine

REGOLE:
- Solo fatti concreti e verificabili (no opinioni, no temporanei)
- Max 8 fatti per meeting
- Ogni fatto = frase chiara e autosufficiente, leggibile senza contesto
- Ignora dettagli operativi che cambiano spesso

NOTE DEL MEETING "${meetingTitle}":
${docContent.slice(0, 5000)}

Rispondi SOLO con JSON:
{"facts": [{"fact": "...", "category": "team|project|client|process|decision"}]}`;

  try {
    const raw = await agent.think(prompt);
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return;
    const extracted = JSON.parse(match[0]) as { facts: Array<{ fact: string; category: string }> };
    if (!extracted.facts?.length) return;

    const newFacts: CompanyFact[] = extracted.facts.map((f) => ({
      fact: f.fact,
      category: (f.category as CompanyFact["category"]) ?? "process",
      extractedFrom: meetingTitle,
      date: meetingDate,
    }));

    const existingRaw = await rGet(FACTS_KEY);
    const existing: CompanyFact[] = existingRaw ? JSON.parse(existingRaw) : [];
    const existingTexts = new Set(existing.map((f) => f.fact.toLowerCase()));
    const toAdd = newFacts.filter((f) => !existingTexts.has(f.fact.toLowerCase()));

    // Conflict detection: ask Claude if any new facts supersede existing ones in the same category
    if (toAdd.length > 0 && existing.length > 0) {
      const categories = new Set(toAdd.map((f) => f.category));
      const sameCategory = existing.filter((f) => categories.has(f.category));
      if (sameCategory.length > 0) {
        try {
          const conflictPrompt = `Analizza questi NUOVI FATTI e i FATTI ESISTENTI. Identifica quali fatti esistenti sono CONTRADDETTI o SUPERATI dai nuovi fatti (es. un ruolo cambiato, una decisione ribaltata, un dato aggiornato).

NUOVI FATTI:
${toAdd.map((f, i) => `${i + 1}. [${f.category}] ${f.fact}`).join("\n")}

FATTI ESISTENTI (stessa categoria):
${sameCategory.map((f, i) => `${i + 1}. [${f.category}] ${f.fact}`).join("\n")}

Rispondi SOLO con JSON: {"superseded": ["testo esatto del fatto da rimuovere"]}
Se nessun conflitto: {"superseded": []}`;
          const raw = await agent.think(conflictPrompt);
          const match = raw.match(/\{[\s\S]*\}/);
          if (match) {
            const { superseded } = JSON.parse(match[0]) as { superseded: string[] };
            if (superseded?.length) {
              const supersededSet = new Set(superseded.map((s: string) => s.toLowerCase()));
              const removed = existing.filter((f) => supersededSet.has(f.fact.toLowerCase()));
              existing.splice(0, existing.length, ...existing.filter((f) => !supersededSet.has(f.fact.toLowerCase())));
              logger.info({ count: removed.length, facts: removed.map((f) => f.fact.slice(0, 60)) }, "Superseded brain facts removed");
            }
          }
        } catch { /* conflict detection is best-effort */ }
      }
    }

    const merged = [...toAdd, ...existing];
    if (merged.length > 100) merged.splice(100);
    await rSet(FACTS_KEY, JSON.stringify(merged), TTL_FACTS);

    // Also persist to DB as company_fact events
    for (const fact of toAdd) {
      await db.insert(intelligenceEvents).values({
        type: "company_fact",
        content: fact.fact,
        context: `${fact.category} — from: ${meetingTitle}`,
        status: "active",
        metadata: { category: fact.category, source: meetingTitle, date: meetingDate },
      }).catch(() => {});
    }

    logger.info({ count: toAdd.length, meeting: meetingTitle }, "Company facts extracted");
  } catch (err) {
    logger.error({ err }, "Failed to extract company facts");
  }
}

/**
 * Mark a decision as resolved — removes it from the open decisions list.
 */
export async function resolveDecision(decisionText: string): Promise<void> {
  const rawD = await rGet(DECISIONS_KEY);
  if (!rawD) return;
  const decisions: OpenDecision[] = JSON.parse(rawD);
  const filtered = decisions.filter((d) =>
    !d.decision.toLowerCase().includes(decisionText.toLowerCase()),
  );
  await rSet(DECISIONS_KEY, JSON.stringify(filtered), TTL_DECISIONS);
}

/**
 * Load brain context as a compact string for injection into the agent system prompt.
 * Keeps total size under ~600 tokens.
 */
export async function loadBrainContext(): Promise<string> {
  const [meetingsRaw, decisionsRaw, factsRaw] = await Promise.all([
    rGet(MEETINGS_KEY),
    rGet(DECISIONS_KEY),
    rGet(FACTS_KEY),
  ]);

  if (!meetingsRaw && !decisionsRaw && !factsRaw) return "";

  const parts: string[] = [];

  // Recent meetings (last 4)
  if (meetingsRaw) {
    const meetings: BrainMeeting[] = JSON.parse(meetingsRaw);
    const recent = meetings.slice(0, 4);
    if (recent.length) {
      const lines = recent.map((m) => {
        const dec = m.keyDecisions.length ? ` | Decisioni: ${m.keyDecisions.slice(0, 2).join("; ")}` : "";
        const acts = m.actionItems.slice(0, 3).map((a) => `    - ${a.title}${a.assignee ? ` (${a.assignee})` : ""}`).join("\n");
        return `• [${m.date}] ${m.title}\n  ${m.summary.slice(0, 150)}${dec}${acts ? `\n  Action items:\n${acts}` : ""}`;
      });
      parts.push(`ULTIMI MEETING:\n${lines.join("\n\n")}`);
    }
  }

  // Open decisions (max 8)
  if (decisionsRaw) {
    const decisions: OpenDecision[] = JSON.parse(decisionsRaw);
    const open = decisions.slice(0, 8);
    if (open.length) {
      const lines = open.map((d) => `• ${d.decision} [${d.meeting}, ${d.date}]`);
      parts.push(`DECISIONI APERTE:\n${lines.join("\n")}`);
    }
  }

  // Company facts grouped by category (max 25 total)
  if (factsRaw) {
    const facts: CompanyFact[] = JSON.parse(factsRaw);
    if (facts.length) {
      const byCategory = new Map<string, string[]>();
      for (const f of facts.slice(0, 25)) {
        if (!byCategory.has(f.category)) byCategory.set(f.category, []);
        byCategory.get(f.category)!.push(f.fact);
      }
      const lines: string[] = [];
      for (const [cat, factList] of byCategory) {
        lines.push(`[${cat.toUpperCase()}]`);
        factList.slice(0, 5).forEach((f) => lines.push(`  • ${f}`));
      }
      parts.push(`FATTI AZIENDALI:\n${lines.join("\n")}`);
    }
  }

  if (!parts.length) return "";
  return `\n\n---\nCONTESTO AZIENDA (aggiornato dai meeting):\n${parts.join("\n\n")}\n---`;
}

/**
 * Rebuild Redis brain from PostgreSQL after a Redis reset or cold start.
 * Only populates keys that are currently empty — never overwrites live data.
 */
export async function rebuildBrainFromDB(): Promise<void> {
  if (!getRedis()) return;

  const [meetingsRaw, factsRaw] = await Promise.all([
    rGet(MEETINGS_KEY),
    rGet(FACTS_KEY),
  ]);

  const needMeetings = !meetingsRaw;
  const needFacts = !factsRaw;
  if (!needMeetings && !needFacts) return;

  if (needMeetings) {
    const rows = await db
      .select()
      .from(intelligenceEvents)
      .where(eq(intelligenceEvents.type, "meeting_notes"))
      .orderBy(desc(intelligenceEvents.createdAt))
      .limit(20)
      .catch(() => []);

    if (rows.length) {
      const meetings: BrainMeeting[] = rows.map((row) => {
        const meta = (row.metadata ?? {}) as Record<string, unknown>;
        const titleFromContent = row.content.split(":")[0] ?? "Meeting";
        return {
          title: (meta.title as string) ?? titleFromContent,
          date: (meta.date as string) ?? row.createdAt?.toISOString().split("T")[0] ?? "",
          attendees: (meta.attendees as string[]) ?? [],
          summary: row.content.replace(/^[^:]+:\s*/, ""),
          keyDecisions: (meta.keyDecisions as string[]) ?? [],
          actionItems: [],
          openQuestions: [],
          processedAt: row.createdAt?.toISOString() ?? new Date().toISOString(),
        };
      });
      await rSet(MEETINGS_KEY, JSON.stringify(meetings), TTL_MEETINGS);
      logger.info({ count: meetings.length }, "Brain meetings rebuilt from DB");
    }
  }

  if (needFacts) {
    const rows = await db
      .select()
      .from(intelligenceEvents)
      .where(eq(intelligenceEvents.type, "company_fact"))
      .orderBy(desc(intelligenceEvents.createdAt))
      .limit(100)
      .catch(() => []);

    if (rows.length) {
      const facts: CompanyFact[] = rows.map((row) => {
        const meta = (row.metadata ?? {}) as Record<string, unknown>;
        return {
          fact: row.content,
          category: ((meta.category as string) ?? "process") as CompanyFact["category"],
          extractedFrom: (meta.source as string) ?? "unknown",
          date: (meta.date as string) ?? row.createdAt?.toISOString().split("T")[0] ?? "",
        };
      });
      await rSet(FACTS_KEY, JSON.stringify(facts), TTL_FACTS);
      logger.info({ count: facts.length }, "Brain facts rebuilt from DB");
    }
  }
}

/**
 * Active keyword search across brain content.
 * Called by the query_brain AI tool.
 */
export async function queryBrain(query: string, category?: string): Promise<string> {
  const [meetingsRaw, decisionsRaw, factsRaw] = await Promise.all([
    rGet(MEETINGS_KEY),
    rGet(DECISIONS_KEY),
    rGet(FACTS_KEY),
  ]);

  const q = query.toLowerCase();
  const parts: string[] = [];

  if (!category || category === "meeting") {
    const meetings: BrainMeeting[] = meetingsRaw ? JSON.parse(meetingsRaw) : [];
    const matched = meetings.filter((m) =>
      m.title.toLowerCase().includes(q) ||
      m.summary.toLowerCase().includes(q) ||
      m.keyDecisions.some((d) => d.toLowerCase().includes(q)) ||
      m.actionItems.some((a) => a.title.toLowerCase().includes(q)),
    );
    if (matched.length) {
      parts.push(`MEETING:\n${matched.slice(0, 3).map((m) =>
        `• [${m.date}] ${m.title}: ${m.summary.slice(0, 180)}`,
      ).join("\n")}`);
    }
  }

  if (!category || category === "decision") {
    const decisions: OpenDecision[] = decisionsRaw ? JSON.parse(decisionsRaw) : [];
    const matched = decisions.filter((d) => d.decision.toLowerCase().includes(q));
    if (matched.length) {
      parts.push(`DECISIONI:\n${matched.slice(0, 5).map((d) =>
        `• ${d.decision} [${d.meeting}, ${d.date}]`,
      ).join("\n")}`);
    }
  }

  if (!category || category === "fact") {
    const facts: CompanyFact[] = factsRaw ? JSON.parse(factsRaw) : [];
    const matched = facts.filter((f) =>
      f.fact.toLowerCase().includes(q) ||
      (category && f.category === category),
    );
    if (matched.length) {
      parts.push(`FATTI:\n${matched.slice(0, 10).map((f) =>
        `• [${f.category}] ${f.fact}`,
      ).join("\n")}`);
    }
  }

  return parts.length
    ? parts.join("\n\n")
    : "Nessuna informazione trovata nel cervello per questa ricerca.";
}

/**
 * Manually add a stable fact to the brain.
 * Called by the add_brain_fact AI tool or slash command.
 */
export async function addFactToBrain(
  fact: string,
  category: CompanyFact["category"] = "process",
): Promise<void> {
  const newFact: CompanyFact = {
    fact,
    category,
    extractedFrom: "manual",
    date: new Date().toISOString().split("T")[0],
  };

  const existingRaw = await rGet(FACTS_KEY);
  const existing: CompanyFact[] = existingRaw ? JSON.parse(existingRaw) : [];
  if (existing.some((f) => f.fact.toLowerCase() === fact.toLowerCase())) return;

  const merged = [newFact, ...existing];
  if (merged.length > 100) merged.splice(100);
  await rSet(FACTS_KEY, JSON.stringify(merged), TTL_FACTS);

  await db.insert(intelligenceEvents).values({
    type: "company_fact",
    content: fact,
    context: `${category} — from: manual`,
    status: "active",
    metadata: { category, source: "manual", date: newFact.date },
  }).catch(() => {});

  logger.info({ fact: fact.slice(0, 80), category }, "Manual fact added to brain");
}

/**
 * Returns a diagnostic summary of what's currently in the brain.
 * Used by the /brain-status command or AI tool.
 */
export async function getBrainStatus(): Promise<string> {
  const [meetingsRaw, decisionsRaw, factsRaw] = await Promise.all([
    rGet(MEETINGS_KEY),
    rGet(DECISIONS_KEY),
    rGet(FACTS_KEY),
  ]);

  const meetings: BrainMeeting[] = meetingsRaw ? JSON.parse(meetingsRaw) : [];
  const decisions: OpenDecision[] = decisionsRaw ? JSON.parse(decisionsRaw) : [];
  const facts: CompanyFact[] = factsRaw ? JSON.parse(factsRaw) : [];

  const redisOk = getRedis() !== null;
  const lines = [
    `*🧠 Company Brain Status*`,
    `Redis: ${redisOk ? "✅ connesso" : "❌ non disponibile (solo DB)"}`,
    ``,
    `*Meeting in memoria:* ${meetings.length}`,
    ...(meetings.slice(0, 3).map((m) => `  • [${m.date}] ${m.title}`)),
    ``,
    `*Decisioni aperte:* ${decisions.length}`,
    ...(decisions.slice(0, 5).map((d) => `  • ${d.decision.slice(0, 80)}`)),
    ``,
    `*Fatti aziendali:* ${facts.length}`,
    ...Array.from(new Set(facts.map((f) => f.category))).map((cat) =>
      `  • ${cat}: ${facts.filter((f) => f.category === cat).length} fatti`
    ),
  ];
  return lines.join("\n");
}
