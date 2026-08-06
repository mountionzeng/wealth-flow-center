"""XP, wealth calculation, and leveling."""

from __future__ import annotations

from typing import Any

from .models import TASK_TYPES


def quest_reward(minutes: int, task_type: str) -> tuple[int, int]:
    """Return (xp, wealth) for a completed quest."""
    conf = TASK_TYPES.get(task_type, TASK_TYPES["course"])
    xp = max(20, int(minutes * 0.8 * conf["xp_mult"]))
    wealth = max(2, int((minutes / 15) * conf["wealth_mult"]))
    return xp, wealth


def xp_to_next_level(level: int) -> int:
    return 100 + (level - 1) * 40


def apply_level_up(player: dict[str, Any]) -> list[int]:
    """Level up as many times as possible. Returns list of new levels reached."""
    leveled_up: list[int] = []
    while player["xp"] >= xp_to_next_level(player["level"]):
        player["xp"] -= xp_to_next_level(player["level"])
        player["level"] += 1
        leveled_up.append(player["level"])
    return leveled_up
