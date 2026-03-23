from __future__ import annotations

from typing import Any

import structlog

from src.config import settings

logger = structlog.get_logger()


async def sync_kanbanchi_board(bot_app: Any) -> None:
    """Sync tasks from Kanbanchi board.

    This service will use the Kanbanchi API when configured.
    The flow will be:
    1. Fetch all cards from the configured board
    2. Compare with local task DB
    3. Create/update local tasks from Kanbanchi cards
    4. Flag overdue cards
    5. Notify owner of any blocked or overdue items
    """
    # TODO: Integrate with Kanbanchi API
    logger.debug("Kanbanchi sync — API integration pending setup")
