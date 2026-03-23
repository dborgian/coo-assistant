from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Telegram Bot
    telegram_bot_token: str
    telegram_owner_chat_id: int

    # Telethon (userbot for monitoring)
    telethon_api_id: int
    telethon_api_hash: str
    telethon_session_name: str = "coo_userbot"
    monitored_chat_ids: list[int] = []

    # Anthropic
    anthropic_api_key: str
    agent_model: str = "claude-sonnet-4-20250514"

    # Google OAuth2
    google_client_id: str = ""
    google_client_secret: str = ""
    google_redirect_uri: str = "http://localhost:8080/oauth/callback"

    # Kanbanchi
    kanbanchi_api_key: str = ""
    kanbanchi_board_id: str = ""

    # Database
    database_url: str = "sqlite+aiosqlite:///./data/coo.db"

    # Scheduling
    daily_report_hour: int = 8
    daily_report_minute: int = 0
    timezone: str = "America/New_York"
    chat_check_interval_minutes: int = 5
    calendar_check_interval_minutes: int = 15


settings = Settings()  # type: ignore[call-arg]
