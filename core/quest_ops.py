"""Quest CRUD, tag management, player rebuild, and dashboard assembly."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from .models import TASK_TYPES, normalize_task_type_for_storage
from .rewards import apply_level_up, quest_reward, xp_to_next_level
from .stats import (
    build_week_metrics,
    build_week_outline,
    completed_quests,
    course_minutes_recent,
    format_time,
    get_minutes,
    now_local,
    parse_quest_time,
    rolling_day_minutes,
    type_minutes,
    update_streak,
    weekly_reminders,
    COURSE_TAG_LIMIT,
    DASHBOARD_DAY_WINDOW,
)


def canonical_tag_key(task_type: str, course_name: str, title: str) -> tuple[str, str, str]:
    return (
        normalize_task_type_for_storage(task_type),
        (course_name or "").strip().lower(),
        (title or "").strip().lower(),
    )


def tag_label(task_type: str, course_name: str, title: str) -> str:
    conf = TASK_TYPES.get(task_type, TASK_TYPES["course"])
    if course_name.strip():
        return f"{conf['label']} | {course_name.strip()} | {title.strip()}"
    return f"{conf['label']} | {title.strip()}"


def quest_label(q: dict[str, Any]) -> str:
    conf = TASK_TYPES.get(q.get("task_type", "course"), TASK_TYPES["course"])
    course = (q.get("course_name") or "").strip()
    if course:
        return f"{conf['label']} | {course} | {q['title']}"
    return f"{conf['label']} | {q['title']}"


def create_or_update_tag(
    state: dict[str, Any],
    task_type: str,
    course_name: str,
    title: str,
    duration_minutes: int,
    event_time: str,
) -> dict[str, Any]:
    task_type = normalize_task_type_for_storage(task_type)
    key = canonical_tag_key(task_type, course_name, title)
    for existing_tag in state["quick_tags"]:
        existing_key = canonical_tag_key(
            str(existing_tag.get("task_type", "course")),
            str(existing_tag.get("course_name", "")),
            str(existing_tag.get("title", "")),
        )
        if existing_key == key:
            existing_tag["duration_minutes"] = max(10, int(duration_minutes))
            existing_tag["uses"] = int(existing_tag.get("uses", 0)) + 1
            existing_tag["last_used_at"] = event_time
            return existing_tag

    new_tag = {
        "id": state["next_tag_id"],
        "task_type": task_type,
        "course_name": course_name,
        "title": title,
        "duration_minutes": max(10, int(duration_minutes)),
        "uses": 1,
        "last_used_at": event_time,
    }
    state["next_tag_id"] += 1
    state["quick_tags"].append(new_tag)
    return new_tag


def create_quest_record(
    state: dict[str, Any],
    *,
    task_type: str,
    course_name: str,
    title: str,
    start: 'datetime',
    end: 'datetime',
    write_calendar: bool,
    touch_tag: bool = True,
) -> dict[str, Any]:
    from datetime import datetime  # noqa: F811 — deferred to avoid circular

    task_type = normalize_task_type_for_storage(task_type)
    minutes = get_minutes(start, end)
    reward_xp, reward_wealth = quest_reward(minutes, task_type)
    quest_id = state["next_id"]
    state["next_id"] += 1

    quest = {
        "id": quest_id,
        "title": title,
        "course_name": course_name,
        "task_type": task_type,
        "start": format_time(start),
        "end": format_time(end),
        "duration_minutes": minutes,
        "reward_xp": reward_xp,
        "reward_wealth": reward_wealth,
        "status": "todo",
        "created_at": format_time(now_local()),
        "completed_at": None,
        "calendar_sync_status": "pending" if write_calendar else "skipped",
        "calendar_sync_message": "",
    }
    state["quests"].append(quest)

    if touch_tag:
        create_or_update_tag(
            state=state,
            task_type=task_type,
            course_name=course_name,
            title=title,
            duration_minutes=minutes,
            event_time=quest["created_at"],
        )

    return quest


def complete_quest(state: dict[str, Any], quest_id: int) -> dict[str, Any] | None:
    """Mark a quest as done, update player stats. Returns the quest or None."""
    target = next((q for q in state["quests"] if int(q.get("id", 0)) == quest_id), None)
    if target is None or target.get("status") == "done":
        return None

    target["status"] = "done"
    target["completed_at"] = format_time(now_local())

    minutes = int(target.get("duration_minutes", 0))
    if int(target.get("reward_xp", 0)) <= 0 or int(target.get("reward_wealth", 0)) <= 0:
        rx, rw = quest_reward(minutes, str(target.get("task_type", "course")))
        target["reward_xp"] = rx
        target["reward_wealth"] = rw

    player = state["player"]
    player["xp"] += int(target.get("reward_xp", 0))
    player["wealth"] += int(target.get("reward_wealth", 0))
    player["total_done"] += 1
    player["total_minutes"] += minutes
    update_streak(player, now_local())
    apply_level_up(player)

    return target


def delete_quest(state: dict[str, Any], quest_id: int) -> dict[str, Any] | None:
    """Remove a quest. Rebuilds player if the quest was done. Returns removed quest or None."""
    index = next(
        (idx for idx, q in enumerate(state["quests"]) if int(q.get("id", 0)) == quest_id),
        -1,
    )
    if index < 0:
        return None

    removed = state["quests"].pop(index)
    if removed.get("status") == "done":
        rebuild_player_from_quests(state)
    return removed


def rebuild_player_from_quests(state: dict[str, Any]) -> None:
    player = {
        "level": 1,
        "xp": 0,
        "wealth": 0,
        "streak": 0,
        "last_completed_date": None,
        "total_done": 0,
        "total_minutes": 0,
    }

    done_rows: list[tuple] = []
    for q in state.get("quests", []):
        if q.get("status") != "done":
            continue
        when = parse_quest_time(q.get("completed_at")) or parse_quest_time(q.get("end")) or now_local()
        done_rows.append((when, q))

    done_rows.sort(key=lambda x: x[0])
    for done_at, q in done_rows:
        minutes = int(q.get("duration_minutes", 0))
        if int(q.get("reward_xp", 0)) <= 0 or int(q.get("reward_wealth", 0)) <= 0:
            rx, rw = quest_reward(minutes, str(q.get("task_type", "course")))
            q["reward_xp"] = rx
            q["reward_wealth"] = rw

        player["xp"] += int(q.get("reward_xp", 0))
        player["wealth"] += int(q.get("reward_wealth", 0))
        player["total_done"] += 1
        player["total_minutes"] += minutes
        update_streak(player, done_at)
        apply_level_up(player)

    state["player"] = player


def dashboard_payload(state: dict[str, Any]) -> dict[str, Any]:
    now = now_local()
    done = completed_quests(state)
    by_day = rolling_day_minutes(done, now, window_days=DASHBOARD_DAY_WINDOW)
    by_type = type_minutes(done)
    by_course = course_minutes_recent(done, now, window_days=DASHBOARD_DAY_WINDOW, limit=COURSE_TAG_LIMIT)
    weekly = build_week_metrics(state, now)
    weekly_outline = build_week_outline(state, now)

    quests_sorted = sorted(state["quests"], key=lambda q: q.get("start", ""), reverse=True)
    quest_rows = []
    for q in quests_sorted:
        quest_rows.append(
            {
                "id": q["id"],
                "title": q.get("title", ""),
                "label": quest_label(q),
                "task_type": q.get("task_type", "course"),
                "course_name": q.get("course_name", ""),
                "start": q.get("start", ""),
                "end": q.get("end", ""),
                "completed_at": q.get("completed_at", ""),
                "duration_minutes": int(q.get("duration_minutes", 0)),
                "status": q.get("status", "todo"),
                "reward_xp": int(q.get("reward_xp", 0)),
                "reward_wealth": int(q.get("reward_wealth", 0)),
                "calendar_sync_status": q.get("calendar_sync_status", "done"),
                "calendar_sync_message": q.get("calendar_sync_message", ""),
            }
        )

    tags_sorted = sorted(
        state.get("quick_tags", []),
        key=lambda t: (t.get("last_used_at", ""), int(t.get("uses", 0))),
        reverse=True,
    )
    tag_rows = []
    for t in tags_sorted:
        row = {
            "id": int(t.get("id", 0)),
            "task_type": str(t.get("task_type", "course")),
            "course_name": str(t.get("course_name", "")),
            "title": str(t.get("title", "")),
            "duration_minutes": int(t.get("duration_minutes", 60)),
            "uses": int(t.get("uses", 0)),
            "last_used_at": str(t.get("last_used_at", "")),
        }
        row["label"] = tag_label(
            row["task_type"],
            row["course_name"],
            row["title"],
        )
        tag_rows.append(row)

    player = state["player"]
    player_out = {
        "level": int(player.get("level", 1)),
        "xp": int(player.get("xp", 0)),
        "xp_target": xp_to_next_level(int(player.get("level", 1))),
        "wealth": int(player.get("wealth", 0)),
        "streak": int(player.get("streak", 0)),
        "total_done": int(player.get("total_done", 0)),
        "total_minutes": int(player.get("total_minutes", 0)),
    }

    return {
        "server_time": format_time(now),
        "player": player_out,
        "quests": quest_rows,
        "quick_tags": tag_rows,
        "charts": {
            "days": list(by_day.keys()),
            "day_minutes": [by_day[d] for d in by_day.keys()],
            "type_minutes": by_type,
            "course_minutes": by_course,
        },
        "weekly": weekly,
        "weekly_outline": weekly_outline,
        "reminders": weekly_reminders(weekly),
    }
