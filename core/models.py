"""Task types, constants, and alias mappings."""

from __future__ import annotations

from typing import Any


TIME_FMT = "%Y-%m-%d %H:%M"
DATE_FMT = "%Y-%m-%d"
WEEKLY_GOAL_MINUTES = 600
WEEKLY_COURSE_GOAL = 2
DASHBOARD_DAY_WINDOW = 30
COURSE_TAG_LIMIT = 10

TASK_TYPES: dict[str, dict[str, Any]] = {
    "course": {
        "label": "课程学习",
        "calendar_tag": "课程",
        "xp_mult": 1.0,
        "wealth_mult": 1.0,
    },
    "review": {
        "label": "复习巩固",
        "calendar_tag": "复习",
        "xp_mult": 0.9,
        "wealth_mult": 0.9,
    },
    "skill": {
        "label": "技能拓展",
        "calendar_tag": "技能",
        "xp_mult": 1.1,
        "wealth_mult": 1.2,
    },
    "practice": {
        "label": "实践",
        "calendar_tag": "实践",
        "xp_mult": 1.05,
        "wealth_mult": 1.1,
    },
    "knowledge": {
        "label": "知识库搭建",
        "calendar_tag": "知识库",
        "xp_mult": 1.0,
        "wealth_mult": 1.1,
    },
    "homework": {
        "label": "做作业",
        "calendar_tag": "作业",
        "xp_mult": 0.95,
        "wealth_mult": 1.0,
    },
}

TASK_TYPE_ALIASES: dict[str, str] = {
    "course": "course",
    "课程": "course",
    "课程学习": "course",
    "review": "review",
    "复习": "review",
    "复习巩固": "review",
    "skill": "skill",
    "技能": "skill",
    "技能拓展": "skill",
    "practice": "practice",
    "practise": "practice",
    "实践": "practice",
    "knowledge": "knowledge",
    "knowledge_base": "knowledge",
    "knowledge-base": "knowledge",
    "knowledgebase": "knowledge",
    "kb": "knowledge",
    "知识库": "knowledge",
    "知识库搭建": "knowledge",
    "homework": "homework",
    "assignment": "homework",
    "assignments": "homework",
    "home_work": "homework",
    "home-work": "homework",
    "作业": "homework",
    "做作业": "homework",
}


def normalize_task_type(raw: Any) -> str:
    value = str(raw or "").strip().lower()
    if not value:
        return "course"
    return TASK_TYPE_ALIASES.get(value, value)


def normalize_task_type_for_storage(raw: Any) -> str:
    task_type = normalize_task_type(raw)
    return task_type if task_type in TASK_TYPES else "course"
