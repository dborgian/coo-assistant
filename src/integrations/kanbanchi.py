from __future__ import annotations

from typing import Any

import httpx
import structlog

from src.config import settings

logger = structlog.get_logger()


class KanbanchiIntegration:
    """Direct API client for Kanbanchi board management.

    Kanbanchi boards are managed through their API.
    This provides methods for reading board state and updating cards.
    """

    def __init__(self) -> None:
        self.api_key = settings.kanbanchi_api_key
        self.board_id = settings.kanbanchi_board_id
        self.base_url = "https://kanbanchi.com/api/v1"

    @property
    def configured(self) -> bool:
        return bool(self.api_key and self.board_id)

    async def get_board_cards(self) -> list[dict[str, Any]]:
        """Fetch all cards from the configured board."""
        if not self.configured:
            logger.warning("Kanbanchi not configured")
            return []

        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"{self.base_url}/boards/{self.board_id}/cards",
                headers={"Authorization": f"Bearer {self.api_key}"},
            )
            resp.raise_for_status()
            return resp.json().get("cards", [])

    async def get_overdue_cards(self) -> list[dict[str, Any]]:
        """Get cards past their due date."""
        cards = await self.get_board_cards()
        from datetime import datetime

        now = datetime.now().isoformat()
        return [c for c in cards if c.get("dueDate") and c["dueDate"] < now and c.get("status") != "done"]

    async def update_card(self, card_id: str, updates: dict[str, Any]) -> dict[str, Any]:
        """Update a card on the board."""
        if not self.configured:
            return {}

        async with httpx.AsyncClient() as client:
            resp = await client.patch(
                f"{self.base_url}/cards/{card_id}",
                headers={"Authorization": f"Bearer {self.api_key}"},
                json=updates,
            )
            resp.raise_for_status()
            return resp.json()
