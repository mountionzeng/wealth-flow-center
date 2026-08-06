#!/usr/bin/env python3
"""财富流通中心: CLI interface — thin interaction layer over core/."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any

from core.models import TASK_TYPES, TIME_FMT
from core.rewards import apply_level_up, xp_to_next_level
from core.stats import (
    completed_quests,
    format_time,
    now_local,
    parse_time,
    rolling_day_minutes,
    type_minutes,
    update_streak,
    build_week_metrics,
    weekly_reminders,
)
from core.storage import load_state, save_state
from core.calendar_sync import add_to_calendar

GAME_NAME = "财富流通中心"
STATE_FILE = Path(__file__).resolve().parent / "study_state.json"

# Menu keys for task type selection
TASK_TYPE_MENU = [
    ("1", "course"),
    ("2", "review"),
    ("3", "skill"),
    ("4", "practice"),
    ("5", "knowledge"),
    ("6", "homework"),
]
TASK_TYPE_MENU_MAP = dict(TASK_TYPE_MENU)


def bar(value: int, max_value: int, width: int = 28) -> str:
    if max_value <= 0:
        return "." * width
    filled = int((value / max_value) * width)
    filled = max(0, min(width, filled))
    return "#" * filled + "." * (width - filled)


def print_header() -> None:
    print(f"\n=== {GAME_NAME} | 知识就是财富 ===")
    print("1) 新建学习任务 + 添加到苹果日历")
    print("2) 完成一个任务（领取财富）")
    print("3) 查看任务列表")
    print("4) 查看角色状态")
    print("5) 查看学习时间可视化")
    print("6) 查看本周目标提醒")
    print("7) 退出")


def choose_task_type() -> tuple[str, dict[str, Any]]:
    print("学习类型：")
    for key, type_key in TASK_TYPE_MENU:
        conf = TASK_TYPES[type_key]
        print(f"  {key}) {conf['label']}")
    raw = input("选择类型（默认 1）: ").strip() or "1"
    type_key = TASK_TYPE_MENU_MAP.get(raw, "course")
    return type_key, TASK_TYPES[type_key]


def quest_label(q: dict[str, Any]) -> str:
    conf = TASK_TYPES.get(q.get("task_type", "course"), TASK_TYPES["course"])
    course = q.get("course_name", "").strip()
    if course:
        return f"{conf['label']} | {course} | {q['title']}"
    return f"{conf['label']} | {q['title']}"


def create_quest(state: dict[str, Any]) -> None:
    task_type_key, conf = choose_task_type()
    course_name = input("课程/技能名称（如 CS584、Python）: ").strip()
    title = input("任务标题: ").strip()
    if not title:
        print("标题不能为空。")
        return

    start_raw = input(f"开始时间（{TIME_FMT}）: ").strip()
    end_raw = input(f"结束时间（{TIME_FMT}）: ").strip()
    try:
        start = parse_time(start_raw)
        end = parse_time(end_raw)
    except ValueError:
        print("时间格式错误。示例：2026-04-14 22:00")
        return
    if end <= start:
        print("结束时间必须晚于开始时间。")
        return

    from core.rewards import quest_reward
    from core.stats import get_minutes

    minutes = get_minutes(start, end)
    reward_xp, reward_wealth = quest_reward(minutes, task_type_key)

    if course_name:
        calendar_title = f"{course_name} - {title}"
    else:
        calendar_title = title
    ok, msg = add_to_calendar(calendar_title, start, end)
    if not ok:
        print(f"写入苹果日历失败：{msg}")
        return

    from core.quest_ops import create_quest_record

    quest = create_quest_record(
        state=state,
        task_type=task_type_key,
        course_name=course_name,
        title=title,
        start=start,
        end=end,
        write_calendar=False,  # already written above
        touch_tag=True,
    )
    save_state(state, STATE_FILE)
    print(f"任务创建成功（ID={quest['id']}），并已写入苹果日历。")
    print(f"预计奖励：+{reward_xp} XP，+{reward_wealth} 财富值，学习时长 {minutes} 分钟")


def list_quests(state: dict[str, Any]) -> None:
    quests = state["quests"]
    if not quests:
        print("还没有任务。")
        return
    print("\n--- 任务列表 ---")
    for q in quests:
        status = "未完成" if q["status"] == "todo" else "已完成"
        minutes = int(q.get("duration_minutes", 0))
        print(
            f"ID {q['id']:>3} | {status} | {q['start']} -> {q['end']} ({minutes}m) | {quest_label(q)}"
        )


def complete_quest_cli(state: dict[str, Any]) -> None:
    open_quests = [q for q in state["quests"] if q["status"] == "todo"]
    if not open_quests:
        print("没有可完成的任务。")
        return
    list_quests(state)

    raw = input("输入要完成的任务 ID: ").strip()
    if not raw.isdigit():
        print("ID 必须是数字。")
        return
    quest_id = int(raw)

    from core.quest_ops import complete_quest

    target = complete_quest(state, quest_id)
    if target is None:
        print("找不到这个任务 ID，或者已经完成了。")
        return

    save_state(state, STATE_FILE)
    player = state["player"]
    print(
        f"任务完成：+{target['reward_xp']} XP，+{target['reward_wealth']} 财富值，连续学习 {player['streak']} 天"
    )


def show_player(state: dict[str, Any]) -> None:
    p = state["player"]
    need = xp_to_next_level(p["level"])
    metrics = build_week_metrics(state, now_local())
    print("\n--- 角色状态 ---")
    print(f"等级: {p['level']}")
    print(f"经验: {p['xp']} / {need}")
    print(f"财富值: {p['wealth']}")
    print(f"连续学习: {p['streak']} 天")
    print(f"总完成任务: {p['total_done']}")
    print(f"总学习时长: {p['total_minutes']} 分钟")
    print(
        f"本周课程进度: {metrics['courses_done']}/{metrics['course_goal']} | "
        f"本周时长: {metrics['weekly_minutes']}/{metrics['weekly_goal_minutes']} 分钟"
    )


def show_visualization(state: dict[str, Any]) -> None:
    done = completed_quests(state)
    if not done:
        print("还没有已完成任务，暂时无法可视化。")
        return

    today = now_local()
    metrics = build_week_metrics(state, today)
    by_day = rolling_day_minutes(done, today, window_days=7)
    by_type = type_minutes(done)

    print("\n--- 最近 7 天学习时长（分钟）---")
    max_day = max(by_day.values()) if by_day else 0
    for day, minutes in by_day.items():
        label = day[5:]
        print(f"{label} | {bar(minutes, max_day)} {minutes}")

    print("\n--- 学习类型总时长（分钟）---")
    labels = [(k, v["label"]) for k, v in TASK_TYPES.items()]
    max_type = max(by_type.values()) if by_type else 0
    for key, cn in labels:
        minutes = by_type.get(key, 0)
        print(f"{cn:>6} | {bar(minutes, max_type)} {minutes}")

    weekly_total = sum(by_day.values())
    from core.models import WEEKLY_GOAL_MINUTES
    print("\n--- 本周财富进度 ---")
    print(f"学习时长: {weekly_total} / {WEEKLY_GOAL_MINUTES} 分钟")
    print(f"进度条  : {bar(min(weekly_total, WEEKLY_GOAL_MINUTES), WEEKLY_GOAL_MINUTES)}")
    print(
        f"课程门数: {metrics['courses_done']} / {metrics['course_goal']} 门 "
        f"({metrics['week_start']} ~ {metrics['week_end']})"
    )


def show_weekly_tracker(state: dict[str, Any]) -> None:
    metrics = build_week_metrics(state, now_local())
    reminders = weekly_reminders(metrics)

    print("\n--- 本周目标提醒 ---")
    print(f"周期: {metrics['week_start']} ~ {metrics['week_end']}")
    print(
        f"课程目标: {metrics['courses_done']}/{metrics['course_goal']} "
        f"| {bar(metrics['courses_done'], metrics['course_goal'], 20)}"
    )
    print(
        f"时长目标: {metrics['weekly_minutes']}/{metrics['weekly_goal_minutes']} 分钟 "
        f"| {bar(min(metrics['weekly_minutes'], metrics['weekly_goal_minutes']), metrics['weekly_goal_minutes'], 20)}"
    )
    if metrics["done_courses"]:
        print("已完成课程:", "、".join(metrics["done_courses"]))
    else:
        print("已完成课程: 暂无")
    print(f"本周待完成课程任务: {metrics['planned_course_tasks']} 个")
    print("\n提醒建议：")
    for msg in reminders:
        print(f"- {msg}")


def print_auto_weekly_hint(state: dict[str, Any]) -> None:
    metrics = build_week_metrics(state, now_local())
    remaining_courses = max(0, metrics["course_goal"] - metrics["courses_done"])
    remaining_minutes = max(0, metrics["weekly_goal_minutes"] - metrics["weekly_minutes"])

    print(
        f"本周追踪: 课程 {metrics['courses_done']}/{metrics['course_goal']} | "
        f"时长 {metrics['weekly_minutes']}/{metrics['weekly_goal_minutes']} 分钟"
    )
    if metrics["days_left"] <= 2 and (remaining_courses > 0 or remaining_minutes > 0):
        print(
            f"提醒: 距离周末约 {metrics['days_left'] + 1} 天，"
            f"还差 {remaining_courses} 门课程，{remaining_minutes} 分钟学习时长。"
        )


def main() -> None:
    state = load_state(STATE_FILE)
    while True:
        print_header()
        print_auto_weekly_hint(state)
        choice = input("选择操作: ").strip()
        if choice == "1":
            create_quest(state)
        elif choice == "2":
            complete_quest_cli(state)
        elif choice == "3":
            list_quests(state)
        elif choice == "4":
            show_player(state)
        elif choice == "5":
            show_visualization(state)
        elif choice == "6":
            show_weekly_tracker(state)
        elif choice == "7":
            print(f"已退出 {GAME_NAME}。")
            break
        else:
            print("无效选项，请输入 1-7。")


if __name__ == "__main__":
    main()
