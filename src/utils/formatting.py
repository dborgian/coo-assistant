from __future__ import annotations


def truncate(text: str, max_len: int = 200) -> str:
    if len(text) <= max_len:
        return text
    return text[: max_len - 3] + "..."


def priority_emoji(priority: str) -> str:
    return {"urgent": "🔴", "high": "🟠", "medium": "🟡", "low": "🟢"}.get(priority, "⚪")


def format_task_line(title: str, status: str, priority: str, due: str | None = None) -> str:
    emoji = priority_emoji(priority)
    due_text = f" (due {due})" if due else ""
    return f"{emoji} [{status}] {title}{due_text}"
