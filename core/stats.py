"""Statistics: weekly metrics, daily minutes, streaks, charts data."""

from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any

from .models import (
    COURSE_TAG_LIMIT,
    DASHBOARD_DAY_WINDOW,
    DATE_FMT,
    TASK_TYPES,
    TIME_FMT,
    WEEKLY_COURSE_GOAL,
    WEEKLY_GOAL_MINUTES,
)


def now_local() -> datetime:
    return datetime.now()


def parse_time(raw: str) -> datetime:
    return datetime.strptime(raw.strip(), TIME_FMT)


def format_time(dt: datetime) -> str:
    return dt.strftime(TIME_FMT)


def get_minutes(start: datetime, end: datetime) -> int:
    return max(int((end - start).total_seconds() // 60), 10)


def parse_quest_time(raw: str | None) -> datetime | None:
    if not raw:
        return None
    try:
        return parse_time(raw)
    except ValueError:
        return None


def next_half_hour_slot(base: datetime | None = None) -> datetime:
    point = base or now_local()
    point = point.replace(second=0, microsecond=0)
    minute = point.minute
    if minute == 0 or minute == 30:
        return point + timedelta(minutes=30)
    if minute < 30:
        return point.replace(minute=30)
    return (point + timedelta(hours=1)).replace(minute=0)


def update_streak(player: dict[str, Any], completed_at: datetime) -> None:
    today = completed_at.date()
    raw_last = player.get("last_completed_date")
    if raw_last is None:
        player["streak"] = 1
    else:
        last_day = datetime.strptime(raw_last, DATE_FMT).date()
        if last_day == today:
            pass
        elif last_day == today - timedelta(days=1):
            player["streak"] += 1
        else:
            player["streak"] = 1
    player["last_completed_date"] = today.strftime(DATE_FMT)


def completed_quests(state: dict[str, Any]) -> list[dict[str, Any]]:
    return [q for q in state["quests"] if q.get("status") == "done"]


def stats_anchor_time(q: dict[str, Any]) -> datetime | None:
    return (
        parse_quest_time(q.get("start"))
        or parse_quest_time(q.get("end"))
        or parse_quest_time(q.get("completed_at"))
    )


def week_bounds(today: datetime) -> tuple[date, date]:
    monday = today.date() - timedelta(days=today.weekday())
    sunday = monday + timedelta(days=6)
    return monday, sunday


def rolling_day_minutes(
    done_quests: list[dict[str, Any]],
    today: datetime,
    window_days: int = DASHBOARD_DAY_WINDOW,
) -> dict[str, int]:
    days: list[str] = []
    totals: dict[str, int] = {}
    for i in range(window_days - 1, -1, -1):
        day = (today.date() - timedelta(days=i)).strftime(DATE_FMT)
        days.append(day)
        totals[day] = 0

    for q in done_quests:
        q_time = stats_anchor_time(q)
        if not q_time:
            continue
        day = q_time.strftime(DATE_FMT)
        if day in totals:
            totals[day] += int(q.get("duration_minutes", 0))

    return {day: totals[day] for day in days}


def course_minutes_recent(
    done_quests: list[dict[str, Any]],
    today: datetime,
    window_days: int = DASHBOARD_DAY_WINDOW,
    limit: int = COURSE_TAG_LIMIT,
) -> list[dict[str, Any]]:
    start_date = today.date() - timedelta(days=window_days - 1)
    totals: dict[str, dict[str, Any]] = {}

    for q in done_quests:
        q_time = stats_anchor_time(q)
        if not q_time:
            continue
        q_date = q_time.date()
        if q_date < start_date or q_date > today.date():
            continue

        course_name = (q.get("course_name") or q.get("title") or "未命名课程").strip()
        key = course_name.lower()
        if key not in totals:
            totals[key] = {"course_name": course_name, "minutes": 0, "sessions": 0}

        totals[key]["minutes"] += int(q.get("duration_minutes", 0))
        totals[key]["sessions"] += 1

    rows = list(totals.values())
    rows.sort(key=lambda item: (int(item["minutes"]), int(item["sessions"])), reverse=True)
    return rows[:limit]


def type_minutes(done_quests: list[dict[str, Any]]) -> dict[str, int]:
    totals: dict[str, int] = {k: 0 for k in TASK_TYPES}
    for q in done_quests:
        q_type = q.get("task_type", "course")
        totals[q_type] = totals.get(q_type, 0) + int(q.get("duration_minutes", 0))
    return totals


def build_week_metrics(state: dict[str, Any], today: datetime) -> dict[str, Any]:
    monday, sunday = week_bounds(today)
    week_done: list[dict[str, Any]] = []

    for q in completed_quests(state):
        q_time = stats_anchor_time(q)
        if q_time and monday <= q_time.date() <= sunday:
            week_done.append(q)

    weekly_minutes_total = sum(int(q.get("duration_minutes", 0)) for q in week_done)
    done_courses_keys: set[str] = set()
    done_courses: list[str] = []
    for q in week_done:
        if q.get("task_type") != "course":
            continue
        name = (q.get("course_name") or q.get("title") or "未命名课程").strip()
        key = name.lower()
        if key in done_courses_keys:
            continue
        done_courses_keys.add(key)
        done_courses.append(name)

    planned_course_tasks = 0
    for q in state["quests"]:
        if q.get("status") != "todo" or q.get("task_type") != "course":
            continue
        q_start = parse_quest_time(q.get("start"))
        if q_start and monday <= q_start.date() <= sunday:
            planned_course_tasks += 1

    return {
        "week_start": monday.strftime(DATE_FMT),
        "week_end": sunday.strftime(DATE_FMT),
        "days_left": max(0, (sunday - today.date()).days),
        "weekly_minutes": weekly_minutes_total,
        "weekly_goal_minutes": WEEKLY_GOAL_MINUTES,
        "course_goal": WEEKLY_COURSE_GOAL,
        "courses_done": len(done_courses),
        "done_courses": done_courses,
        "planned_course_tasks": planned_course_tasks,
    }


def build_week_outline(state: dict[str, Any], today: datetime) -> list[dict[str, Any]]:
    monday, sunday = week_bounds(today)
    weekday_cn = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]
    day_buckets: dict[str, list[dict[str, Any]]] = {}

    for i in range(7):
        day = (monday + timedelta(days=i)).strftime(DATE_FMT)
        day_buckets[day] = []

    for q in state.get("quests", []):
        start_dt = parse_quest_time(q.get("start"))
        end_dt = parse_quest_time(q.get("end"))
        if not start_dt:
            continue
        if not (monday <= start_dt.date() <= sunday):
            continue

        day_key = start_dt.strftime(DATE_FMT)
        conf = TASK_TYPES.get(str(q.get("task_type", "course")), TASK_TYPES["course"])
        day_buckets[day_key].append(
            {
                "id": int(q.get("id", 0)),
                "title": str(q.get("title", "")),
                "course_name": str(q.get("course_name", "")),
                "task_type": str(q.get("task_type", "course")),
                "task_type_label": conf["label"],
                "start": format_time(start_dt),
                "end": format_time(end_dt) if end_dt else "",
                "start_time": start_dt.strftime("%H:%M"),
                "end_time": end_dt.strftime("%H:%M") if end_dt else "",
                "duration_minutes": int(q.get("duration_minutes", 0)),
                "status": str(q.get("status", "todo")),
            }
        )

    outline = []
    for i in range(7):
        day_date = monday + timedelta(days=i)
        day_key = day_date.strftime(DATE_FMT)
        tasks = sorted(day_buckets[day_key], key=lambda t: t.get("start", ""))
        outline.append(
            {
                "date": day_key,
                "weekday": weekday_cn[i],
                "is_today": day_date == today.date(),
                "tasks": tasks,
            }
        )
    return outline


def weekly_reminders(metrics: dict[str, Any]) -> list[str]:
    reminders: list[str] = []
    remaining_courses = max(0, metrics["course_goal"] - metrics["courses_done"])
    remaining_minutes = max(0, metrics["weekly_goal_minutes"] - metrics["weekly_minutes"])
    days_left = int(metrics["days_left"])

    if remaining_courses == 0:
        reminders.append("本周课程目标已完成，继续保持。")
    elif days_left <= 2:
        reminders.append(f"本周还差 {remaining_courses} 门课程，优先安排课程学习。")
    else:
        reminders.append(
            f"课程目标进度 {metrics['courses_done']}/{metrics['course_goal']}，还差 {remaining_courses} 门。"
        )

    if remaining_minutes == 0:
        reminders.append("本周学习时长已达标。")
    elif days_left <= 2:
        reminders.append(f"本周学习时长还差 {remaining_minutes} 分钟，建议加一段复习或技能训练。")
    else:
        reminders.append(
            f"学习时长进度 {metrics['weekly_minutes']}/{metrics['weekly_goal_minutes']} 分钟。"
        )

    if remaining_courses > 0 and metrics["planned_course_tasks"] == 0:
        reminders.append("当前周内没有待完成课程任务，建议新增课程学习日历。")

    return reminders
