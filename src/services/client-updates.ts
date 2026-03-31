import { and, eq, inArray, sql } from "drizzle-orm";
import { agent } from "../core/agent.js";
import { sendOwnerNotification } from "../utils/notify.js";
import { db } from "../models/database.js";
import { clients, tasks } from "../models/schema.js";
import { sendEmail } from "./email-manager.js";
import { logger } from "../utils/logger.js";

export async function sendWeeklyClientUpdates(): Promise<void> {
  const activeClients = await db
    .select()
    .from(clients)
    .where(eq(clients.isActive, true));

  if (!activeClients.length) return;

  let sentCount = 0;

  for (const client of activeClients) {
    if (!client.email) continue;

    // Get tasks related to this client
    const clientTasks = await db
      .select()
      .from(tasks)
      .where(eq(tasks.clientId, client.id));

    if (!clientTasks.length) continue;

    const activeTasks = clientTasks.filter(
      (t) => t.status === "pending" || t.status === "in_progress",
    );
    const completedRecently = clientTasks.filter((t) => {
      if (t.status !== "done") return false;
      const weekAgo = new Date();
      weekAgo.setDate(weekAgo.getDate() - 7);
      return t.updatedAt && new Date(t.updatedAt) >= weekAgo;
    });

    try {
      const emailBody = await agent.think(
        `Genera un aggiornamento settimanale per un cliente. Scrivi in modo professionale e positivo.
Struttura: saluto, task completati questa settimana, task in corso, prossimi step.
Se non ci sono task completati, evidenzia i progressi.
NON usare emoji. Max 300 parole. Lingua: italiano.
Firma come "Il team operativo".`,
        {
          client_name: client.name,
          company: client.company,
          completed_this_week: completedRecently.map((t) => ({
            title: t.title,
            completed: t.updatedAt,
          })),
          active_tasks: activeTasks.map((t) => ({
            title: t.title,
            status: t.status,
            priority: t.priority,
            due: t.dueDate,
          })),
        },
      );

      const today = new Date().toISOString().split("T")[0];
      const sent = await sendEmail(
        client.email,
        `Aggiornamento settimanale — ${client.company ?? client.name} — ${today}`,
        emailBody,
      );

      if (sent) {
        sentCount++;
        logger.info({ client: client.name }, "Weekly client update sent");
      }
    } catch (err) {
      logger.error({ err, client: client.name }, "Failed to send client update");
    }
  }

  if (sentCount) {
    await sendOwnerNotification(`\uD83D\uDCE7 Aggiornamenti settimanali inviati a ${sentCount} client.`).catch((err) =>
      logger.error({ err }, "Failed to notify about client updates"),
    );
  }
}
