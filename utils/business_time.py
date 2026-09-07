"""Business timestamps use fixed UTC+08:00; protocol clocks stay with their owners."""
from datetime import datetime, timedelta, timezone

BEIJING = timezone(timedelta(hours=8))


def beijing_now() -> datetime:
    return datetime.now(BEIJING)


def beijing_iso(value: datetime | float | str | None = None) -> str:
    """Format an instant. Leave legacy unzoned/invalid strings untouched, never guess."""
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value)
        except ValueError:
            return value
        if parsed.tzinfo is None:
            return value
        value = parsed
    if value is None:
        value = beijing_now()
    elif isinstance(value, (int, float)):
        value = datetime.fromtimestamp(value, BEIJING)
    if value.tzinfo is None:
        raise ValueError("Business timestamps require an explicit timezone")
    return value.astimezone(BEIJING).isoformat()
