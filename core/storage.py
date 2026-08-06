"""State persistence with atomic writes and backup rotation."""

from __future__ import annotations

import fcntl
import json
import os
import threading
from pathlib import Path
from typing import Any

from .models import TASK_TYPES, normalize_task_type_for_storage
from .rewards import quest_reward
from .stats import format_time, get_minutes, now_local, parse_time

STATE_LOCK = threading.Lock()

_MAX_BACKUPS = 3


def default_state() -> dict[str, Any]:
    return {
        "player": {
            "level": 1,
            "xp": 0,
            "wealth": 0,
            "streak": 0,
            "last_completed_date": None,
            "total_done": 0,
            "total_minutes": 0,
        },
        "next_id": 1,
        "next_tag_id": 1,
        "quests": [],
        "quick_tags": [],
    }


def _create_or_update_tag_during_migration(
    state: dict[str, Any],
    task_type: str,
    course_name: str,
    title: str,
    duration_minutes: int,
    event_time: str,
) -> None:
    """Lightweight tag upsert used only during state migration."""
    from .quest_ops import canonical_tag_key

    task_type = normalize_task_type_for_storage(task_type)
    key = canonical_tag_key(task_type, course_name, title)
    for tag in state["quick_tags"]:
        tag_key = canonical_tag_key(
            str(tag.get("task_type", "course")),
            str(tag.get("course_name", "")),
            str(tag.get("title", "")),
        )
        if tag_key == key:
            tag["duration_minutes"] = max(10, int(duration_minutes))
            tag["uses"] = int(tag.get("uses", 0)) + 1
            tag["last_used_at"] = event_time
            return

    tag = {
        "id": state["next_tag_id"],
        "task_type": task_type,
        "course_name": course_name,
        "title": title,
        "duration_minutes": max(10, int(duration_minutes)),
        "uses": 1,
        "last_used_at": event_time,
    }
    state["next_tag_id"] += 1
    state["quick_tags"].append(tag)


def migrate_state(state: dict[str, Any]) -> dict[str, Any]:
    player = state.setdefault("player", {})
    player.setdefault("level", 1)
    player.setdefault("xp", 0)
    if "wealth" not in player:
        player["wealth"] = player.get("coins", 0)
    player.setdefault("streak", 0)
    player.setdefault("last_completed_date", None)
    player.setdefault("total_done", 0)
    player.setdefault("total_minutes", 0)

    state.setdefault("next_id", 1)
    state.setdefault("next_tag_id", 1)
    state.setdefault("quests", [])
    state.setdefault("quick_tags", [])

    max_id = 0
    for q in state["quests"]:
        q.setdefault("id", 0)
        if q["id"] > max_id:
            max_id = q["id"]

        q.setdefault("status", "todo")
        q.setdefault("created_at", format_time(now_local()))
        q.setdefault("completed_at", None)
        q.setdefault("task_type", "course")
        q["task_type"] = normalize_task_type_for_storage(q.get("task_type", "course"))
        q.setdefault("course_name", "")
        q.setdefault("reward_xp", 0)
        q.setdefault("calendar_sync_status", "done")
        q.setdefault("calendar_sync_message", "")
        if "reward_wealth" not in q:
            q["reward_wealth"] = q.get("reward_coins", 0)

        if "duration_minutes" not in q:
            try:
                start = parse_time(q["start"])
                end = parse_time(q["end"])
                q["duration_minutes"] = get_minutes(start, end)
            except Exception:
                q["duration_minutes"] = 60

    if max_id >= state["next_id"]:
        state["next_id"] = max_id + 1

    if player["total_minutes"] == 0:
        done_minutes = sum(
            int(q.get("duration_minutes", 0))
            for q in state["quests"]
            if q.get("status") == "done"
        )
        if done_minutes:
            player["total_minutes"] = done_minutes

    if not state["quick_tags"]:
        for q in sorted(state["quests"], key=lambda x: x.get("created_at", "")):
            _create_or_update_tag_during_migration(
                state=state,
                task_type=str(q.get("task_type", "course")),
                course_name=str(q.get("course_name", "")),
                title=str(q.get("title", "")),
                duration_minutes=int(q.get("duration_minutes", 60)),
                event_time=str(q.get("created_at", format_time(now_local()))),
            )
    else:
        max_tag_id = 0
        for tag in state["quick_tags"]:
            tag.setdefault("id", 0)
            tag.setdefault("task_type", "course")
            tag["task_type"] = normalize_task_type_for_storage(tag.get("task_type", "course"))
            tag.setdefault("course_name", "")
            tag.setdefault("title", "")
            tag.setdefault("duration_minutes", 60)
            tag.setdefault("uses", 1)
            tag.setdefault("last_used_at", format_time(now_local()))
            if int(tag["id"]) > max_tag_id:
                max_tag_id = int(tag["id"])
        if max_tag_id >= state["next_tag_id"]:
            state["next_tag_id"] = max_tag_id + 1

    return state


def load_state(state_file: Path) -> dict[str, Any]:
    if not state_file.exists():
        return default_state()
    try:
        raw = json.loads(state_file.read_text(encoding="utf-8"))
        return migrate_state(raw)
    except (json.JSONDecodeError, OSError):
        backup = state_file.with_suffix(".broken.json")
        try:
            state_file.rename(backup)
        except OSError:
            pass
        return default_state()


def _rotate_backups(state_file: Path) -> None:
    """Keep up to _MAX_BACKUPS numbered backup copies."""
    for i in range(_MAX_BACKUPS, 1, -1):
        older = state_file.with_suffix(f".backup.{i - 1}.json")
        newer = state_file.with_suffix(f".backup.{i}.json")
        if older.exists():
            try:
                older.rename(newer)
            except OSError:
                pass
    if state_file.exists():
        try:
            state_file.rename(state_file.with_suffix(".backup.1.json"))
        except OSError:
            pass


def save_state(state: dict[str, Any], state_file: Path) -> None:
    """Atomic write: write to temp file then os.replace()."""
    data = json.dumps(state, ensure_ascii=False, indent=2)
    tmp_path = state_file.with_suffix(".tmp")
    tmp_path.write_text(data, encoding="utf-8")
    os.replace(str(tmp_path), str(state_file))


def save_state_with_backup(state: dict[str, Any], state_file: Path) -> None:
    """Atomic write with backup rotation."""
    _rotate_backups(state_file)
    save_state(state, state_file)
