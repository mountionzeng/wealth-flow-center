"""Purpose-limited context and output contract for daily body/learning advice."""

from __future__ import annotations

import json
from pathlib import Path
import re
from typing import Any, Dict, Iterable, List

from .ai_gateway import AIGateway


CHECK_IN_FIELDS = ("sleep", "energy", "mood", "discomfort", "note")
SUMMARY_FIELDS = ("body_minutes", "learning_minutes", "variance_minutes")
EVENT_FIELDS = ("calendar_name", "title", "start", "end", "duration_minutes")
SUGGESTION_FIELDS = ("title", "reason", "start_time", "duration_minutes")


def _bounded_text(value: Any, limit: int) -> str:
    text = str(value or "").strip()
    if re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", text):
        raise ValueError("内容包含不支持的控制字符")
    return text[:limit]


def build_daily_context(
    check_in: Dict[str, Any], actual_summary: Dict[str, Any], calendar_events: Iterable[Dict[str, Any]]
) -> Dict[str, Any]:
    check = {field: _bounded_text(check_in.get(field), 240 if field == "note" else 40) for field in CHECK_IN_FIELDS}
    if any(not check[field] for field in CHECK_IN_FIELDS[:-1]):
        raise ValueError("请完整选择睡眠、精力、情绪和身体不适")
    summary = {}
    for field in SUMMARY_FIELDS:
        value = actual_summary.get(field, 0)
        if not isinstance(value, (int, float)):
            raise ValueError("历史汇总格式不正确")
        summary[field] = round(float(value), 1)
    events: List[Dict[str, Any]] = []
    for raw in list(calendar_events)[:200]:
        if not isinstance(raw, dict):
            continue
        event = {field: raw.get(field) for field in EVENT_FIELDS}
        event["calendar_name"] = _bounded_text(event["calendar_name"], 80)
        event["title"] = _bounded_text(event["title"], 160)
        event["start"] = _bounded_text(event["start"], 40)
        event["end"] = _bounded_text(event["end"], 40)
        try:
            event["duration_minutes"] = max(0, min(1440, int(event["duration_minutes"] or 0)))
        except (TypeError, ValueError) as exc:
            raise ValueError("日历时长格式不正确") from exc
        events.append(event)
    return {"check_in": check, "actual_summary": summary, "calendar_history": events}


def _validate_suggestion(raw: Any, kind: str) -> Dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError("建议格式不正确")
    title = _bounded_text(raw.get("title"), 80)
    reason = _bounded_text(raw.get("reason"), 240)
    start_time = _bounded_text(raw.get("start_time"), 5)
    if not title or not reason:
        raise ValueError("建议缺少标题或理由")
    if not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", start_time):
        raise ValueError("建议时间格式必须为 HH:MM")
    try:
        duration = int(raw.get("duration_minutes"))
    except (TypeError, ValueError) as exc:
        raise ValueError("建议时长格式不正确") from exc
    maximum = 120 if kind == "learning" else 90
    if duration < 5 or duration > maximum:
        raise ValueError("建议时长超出允许范围")
    return {
        "title": title,
        "reason": reason,
        "start_time": start_time,
        "duration_minutes": duration,
    }


def validate_daily_advice(raw: Any) -> Dict[str, Dict[str, Any]]:
    if not isinstance(raw, dict) or set(raw.keys()) != {"body", "learning"}:
        raise ValueError("每日建议必须且只能包含一养一学")
    return {
        "body": _validate_suggestion(raw["body"], "body"),
        "learning": _validate_suggestion(raw["learning"], "learning"),
    }


def _prompt() -> str:
    path = Path(__file__).resolve().parent.parent / "prompts" / "daily-advice.md"
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return "根据身体签到与真实执行历史，只生成一条养身建议和一条学习建议。"


def generate_daily_advice(gateway: AIGateway, context: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    user = "以下是完成本次生成所必需的最小化数据：\n" + json.dumps(context, ensure_ascii=False, separators=(",", ":"))
    raw = gateway.complete_json(_prompt(), user, max_tokens=800)
    return validate_daily_advice(raw)
