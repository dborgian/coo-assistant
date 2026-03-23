from __future__ import annotations

from datetime import datetime

import structlog
from sqlalchemy import func, select
from telegram import Update
from telegram.ext import ContextTypes

from src.core.agent import agent
from src.models import Client, Employee, MessageLog, Task
from src.models.database import async_session

logger = structlog.get_logger()


async def start_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text(
        "<b>COO Assistant Online</b>\n\n"
        "I'm your AI Chief Operating Officer. I monitor communications, "
        "track tasks, and keep operations running smoothly.\n\n"
        "Commands:\n"
        "/status — Operations overview\n"
        "/report — Generate operations report\n"
        "/tasks — View active tasks\n"
        "/remind — Set a reminder\n"
        "/add_employee — Add team member\n"
        "/add_client — Add client\n"
        "/monitor — Configure chat monitoring\n"
        "/help — Full help\n\n"
        "Or just send me any message and I'll help.",
        parse_mode="HTML",
    )


async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text(
        "<b>COO Assistant — Commands</b>\n\n"
        "<b>/status</b> — Quick ops overview (tasks, messages, upcoming)\n"
        "<b>/report</b> — Full daily operations report\n"
        "<b>/tasks</b> — List active tasks (add 'overdue' for overdue only)\n"
        "<b>/remind [person] [task] [time]</b> — Set reminder\n"
        "  Example: /remind John Submit report tomorrow 9am\n"
        "<b>/add_employee [name] [email] [role]</b> — Add team member\n"
        "<b>/add_client [name] [company] [email]</b> — Add client\n"
        "<b>/monitor add [chat_id]</b> — Add chat to monitor\n"
        "<b>/monitor list</b> — Show monitored chats\n\n"
        "Any other message → I'll answer as your COO assistant.",
        parse_mode="HTML",
    )


async def status_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    async with async_session() as session:
        task_count = (await session.execute(
            select(func.count(Task.id)).where(Task.status.in_(["pending", "in_progress"]))
        )).scalar() or 0

        overdue_count = (await session.execute(
            select(func.count(Task.id)).where(
                Task.status.in_(["pending", "in_progress"]),
                Task.due_date < datetime.now(),
            )
        )).scalar() or 0

        unread_msgs = (await session.execute(
            select(func.count(MessageLog.id)).where(
                MessageLog.needs_reply == True,  # noqa: E712
                MessageLog.replied == False,  # noqa: E712
            )
        )).scalar() or 0

        employee_count = (await session.execute(
            select(func.count(Employee.id)).where(Employee.is_active)
        )).scalar() or 0

        client_count = (await session.execute(
            select(func.count(Client.id)).where(Client.is_active)
        )).scalar() or 0

    status_text = (
        "<b>Operations Status</b>\n\n"
        f"<b>Tasks:</b> {task_count} active"
    )
    if overdue_count:
        status_text += f" ({overdue_count} overdue)"
    status_text += (
        f"\n<b>Messages needing reply:</b> {unread_msgs}"
        f"\n<b>Team:</b> {employee_count} members"
        f"\n<b>Clients:</b> {client_count} active"
    )
    await update.message.reply_text(status_text, parse_mode="HTML")


async def report_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text("Generating operations report...")

    async with async_session() as session:
        tasks = (await session.execute(
            select(Task).where(Task.status.in_(["pending", "in_progress"]))
        )).scalars().all()

        pending_messages = (await session.execute(
            select(MessageLog).where(
                MessageLog.needs_reply == True,  # noqa: E712
                MessageLog.replied == False,  # noqa: E712
            )
        )).scalars().all()

    data = {
        "date": datetime.now().strftime("%Y-%m-%d"),
        "tasks": [
            {"title": t.title, "status": t.status, "priority": t.priority, "due": str(t.due_date)}
            for t in tasks
        ],
        "pending_messages": [
            {"sender": m.sender_name, "chat": m.chat_title, "urgency": m.urgency, "summary": m.content[:200]}
            for m in pending_messages
        ],
    }

    report = await agent.generate_daily_report(data)
    # Telegram has a 4096 char limit
    if len(report) > 4000:
        for i in range(0, len(report), 4000):
            await update.message.reply_text(report[i : i + 4000])
    else:
        await update.message.reply_text(report)


async def tasks_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    async with async_session() as session:
        query = select(Task).where(Task.status.in_(["pending", "in_progress"])).order_by(Task.priority.desc())
        if context.args and "overdue" in context.args:
            query = query.where(Task.due_date < datetime.now())

        tasks = (await session.execute(query)).scalars().all()

    if not tasks:
        await update.message.reply_text("No active tasks.")
        return

    priority_emoji = {"urgent": "🔴", "high": "🟠", "medium": "🟡", "low": "🟢"}
    lines = ["<b>Active Tasks</b>\n"]
    for t in tasks:
        emoji = priority_emoji.get(t.priority, "⚪")
        due = f" (due {t.due_date.strftime('%m/%d')})" if t.due_date else ""
        lines.append(f"{emoji} [{t.status}] {t.title}{due}")

    await update.message.reply_text("\n".join(lines), parse_mode="HTML")


async def remind_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not context.args or len(context.args) < 2:
        await update.message.reply_text(
            "Usage: /remind [person] [task description]\nExample: /remind John Submit the Q1 report"
        )
        return

    person_name = context.args[0]
    task_desc = " ".join(context.args[1:])

    async with async_session() as session:
        employee = (await session.execute(
            select(Employee).where(Employee.name.ilike(f"%{person_name}%"))
        )).scalar_one_or_none()

        task = Task(
            title=f"Reminder: {task_desc}",
            description=f"Reminder for {person_name}: {task_desc}",
            status="pending",
            priority="high",
            assigned_to=employee.id if employee else None,
            source="manual",
        )
        session.add(task)
        await session.commit()

    reply = f"Reminder set for <b>{person_name}</b>: {task_desc}"
    if employee and employee.email:
        reply += f"\n(Will also send email to {employee.email})"
    await update.message.reply_text(reply, parse_mode="HTML")


async def add_employee_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not context.args or len(context.args) < 1:
        await update.message.reply_text(
            "Usage: /add_employee [name] [email] [role]\n"
            "Example: /add_employee John john@company.com Developer"
        )
        return

    name = context.args[0]
    email = context.args[1] if len(context.args) > 1 else None
    role = " ".join(context.args[2:]) if len(context.args) > 2 else None

    async with async_session() as session:
        emp = Employee(name=name, email=email, role=role)
        session.add(emp)
        await session.commit()

    await update.message.reply_text(f"Added employee: <b>{name}</b> ({role or 'no role'})", parse_mode="HTML")


async def add_client_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not context.args or len(context.args) < 1:
        await update.message.reply_text(
            "Usage: /add_client [name] [company] [email]\n"
            "Example: /add_client Acme AcmeCorp acme@example.com"
        )
        return

    name = context.args[0]
    company = context.args[1] if len(context.args) > 1 else None
    email = context.args[2] if len(context.args) > 2 else None

    async with async_session() as session:
        client = Client(name=name, company=company, email=email)
        session.add(client)
        await session.commit()

    await update.message.reply_text(f"Added client: <b>{name}</b> ({company or 'no company'})", parse_mode="HTML")


async def monitor_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not context.args:
        await update.message.reply_text(
            "Usage:\n/monitor list — Show monitored chats\n/monitor add [chat_id] — Add chat to monitor"
        )
        return

    from src.config import settings

    if context.args[0] == "list":
        if settings.monitored_chat_ids:
            chats = "\n".join(str(c) for c in settings.monitored_chat_ids)
            await update.message.reply_text(f"<b>Monitored chats:</b>\n{chats}", parse_mode="HTML")
        else:
            await update.message.reply_text("No chats being monitored. Use /monitor add [chat_id]")
    elif context.args[0] == "add" and len(context.args) > 1:
        chat_id = int(context.args[1])
        if chat_id not in settings.monitored_chat_ids:
            settings.monitored_chat_ids.append(chat_id)
        await update.message.reply_text(f"Now monitoring chat: {chat_id}")


async def ask_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.message.text
    logger.info("Owner query received", query=query[:100])

    async with async_session() as session:
        response = await agent.answer_query(query, session)

    if len(response) > 4000:
        for i in range(0, len(response), 4000):
            await update.message.reply_text(response[i : i + 4000])
    else:
        await update.message.reply_text(response)
