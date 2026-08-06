"""Evidence-owned orchestration for the structured 问春风 report."""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
import json
from pathlib import Path
import re
from typing import Any, Dict, Iterable, List, Optional, Set

from .ai_gateway import AIGateway, AIProviderError, normalize_profile_fields
from .bazi import parse_bazi, solar_term_context


REPORT_VERSION = "spring-wind-report-2"
FACT_SNAPSHOT_VERSION = "spring-wind-facts-1.0.0"
REQUIRED_CULTURE_SECTIONS = ("summary", "clothing", "direction", "diet", "do_avoid")
ALLOWED_ACTION_KINDS = {"body", "learning", "environment", "daily"}
UNSAFE_OUTPUT = re.compile(
    r"停药|确诊为|诊断为|必有灾|一定会发生|必须迁居|必须投资|绝对(?:相合|不合)|气场测量|科学(?:证明|测得).*气场"
)
HTML_LIKE = re.compile(r"<\s*/?\s*(?:script|iframe|img|svg|style|object|embed|a)\b", re.I)

SECTION_EVIDENCE_TYPES = {
    "summary": {
        "user_input", "deterministic_calendar", "normalized_location",
        "environment_observation", "environment_baseline", "local_history", "context_manifest",
        "user_confirmed_profile",
    },
    "clothing": {"deterministic_calendar", "environment_observation", "environment_baseline", "user_confirmed_profile"},
    "direction": {"deterministic_calendar", "normalized_location", "user_confirmed_profile"},
    "diet": {"deterministic_calendar", "environment_observation", "environment_baseline", "local_history", "user_confirmed_profile"},
    "do_avoid": {
        "deterministic_calendar", "normalized_location", "environment_observation",
        "environment_baseline", "local_history", "context_manifest", "user_confirmed_profile",
    },
    "question": {
        "user_input", "deterministic_calendar", "normalized_location", "environment_observation",
        "environment_baseline", "local_history", "context_manifest", "user_confirmed_profile",
    },
}
ACTION_EVIDENCE_TYPES = {
    "environment": {"environment_observation", "environment_baseline"},
    "body": {"environment_observation", "environment_baseline", "local_history", "deterministic_calendar"},
    "learning": {"local_history", "environment_observation", "deterministic_calendar"},
    "daily": {
        "deterministic_calendar", "normalized_location", "environment_observation",
        "environment_baseline", "local_history", "context_manifest",
    },
}


def _bounded(value: Any, limit: int, label: str, required: bool = True) -> str:
    text = str(value or "").strip()
    if required and not text:
        raise ValueError("请输入{}".format(label))
    if len(text) > limit:
        raise ValueError("{}内容过长".format(label))
    if re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", text):
        raise ValueError("{}包含不支持的控制字符".format(label))
    return text


def _prompt() -> str:
    path = Path(__file__).resolve().parent.parent / "prompts" / "spring-wind.md"
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return "只依据给定事实 ID，返回传统文化解释与可执行行动的 JSON。"


def _consent_categories(manifest: Any, purpose: str) -> Set[str]:
    if not isinstance(manifest, dict):
        return set()
    record = manifest.get(purpose)
    if not isinstance(record, dict) or record.get("granted") is not True or record.get("revoked_at"):
        return set()
    categories = record.get("categories")
    if not isinstance(categories, list):
        return set()
    return {str(item).strip() for item in categories if str(item).strip()}


def _safe_copy(value: Any, depth: int = 0) -> Any:
    if depth > 6:
        raise ValueError("上下文嵌套过深")
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return _bounded(value, 1000, "上下文字段", required=False)
    if isinstance(value, list):
        return [_safe_copy(item, depth + 1) for item in value[:100]]
    if isinstance(value, dict):
        if len(value) > 80:
            raise ValueError("上下文字段过多")
        return {
            _bounded(key, 80, "上下文字段名"): _safe_copy(item, depth + 1)
            for key, item in value.items()
        }
    raise ValueError("上下文格式不正确")


def _fact(
    fact_id: str,
    fact_type: str,
    value: Any,
    source: str,
    status: str = "available",
    **extra: Any,
) -> Dict[str, Any]:
    return {
        "id": fact_id,
        "type": fact_type,
        "value": _safe_copy(value),
        "source": source,
        "status": status,
        **extra,
    }


def _normalize_external_fact(raw: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(raw, dict):
        return None
    fact_id = _bounded(raw.get("id"), 120, "事实 ID", required=False)
    fact_type = _bounded(raw.get("type"), 80, "事实类型", required=False)
    source = _bounded(raw.get("source"), 160, "事实来源", required=False)
    status = str(raw.get("status") or "missing")
    if not fact_id or not fact_type or status not in {"available", "stale", "missing", "partial"}:
        return None
    return _fact(
        fact_id,
        fact_type,
        raw.get("value"),
        source or "环境数据适配器",
        status,
    )


def _history_facts(context: Any) -> List[Dict[str, Any]]:
    if not isinstance(context, dict):
        return []
    facts = []
    for key, fact_id in (
        ("body", "history.body.recent"),
        ("learning", "history.learning.recent"),
        ("execution", "history.execution.recent"),
        ("calendar", "history.calendar.recent"),
        ("history_summary", "history.summary"),
    ):
        if key in context:
            facts.append(_fact(fact_id, "local_history", context[key], "当前浏览器账户"))
    if "manifest" in context:
        facts.append(_fact("history.context.manifest", "context_manifest", context["manifest"], "当前浏览器账户"))
    return facts


def _missing_environment_snapshot(birth_city: str, current_city: str, reason: str) -> Dict[str, Any]:
    return {
        "version": "environment-facts-1.0.0",
        "status": "partial",
        "provider": {"name": "Open-Meteo", "attribution": "Weather data by Open-Meteo.com"},
        "locations": {
            "birth": {"status": "missing", "selected": None, "query": birth_city},
            "current": {"status": "missing", "selected": None, "query": current_city},
        },
        "environment": {
            "status": "missing",
            "current": {"status": "missing", "reason": reason},
            "trend_24h": {"status": "missing", "reason": reason},
            "air_quality": {"status": "missing", "reason": reason},
            "baseline": {"status": "missing", "reason": reason},
        },
        "facts": [
            _fact("location.birth", "normalized_location", None, "Open-Meteo Geocoding", "missing"),
            _fact("location.current", "normalized_location", None, "Open-Meteo Geocoding", "missing"),
            _fact("environment.weather.current", "environment_observation", None, "Open-Meteo Forecast", "missing"),
            _fact("environment.air_quality.current", "environment_observation", None, "Open-Meteo Air Quality", "missing"),
            _fact("environment.baseline.recent", "environment_baseline", None, "Open-Meteo Historical Weather", "missing"),
        ],
    }


def _environment_fact_supplements(snapshot: Dict[str, Any]) -> List[Dict[str, Any]]:
    environment = snapshot.get("environment") if isinstance(snapshot.get("environment"), dict) else {}
    supplements = []
    for key, fact_id, fact_type, source in (
        ("trend_24h", "environment.weather.trend24h", "environment_observation", "Open-Meteo Forecast"),
        ("baseline", "environment.baseline.recent", "environment_baseline", "Open-Meteo Historical Weather"),
    ):
        value = environment.get(key) if isinstance(environment.get(key), dict) else {}
        supplements.append(
            _fact(
                fact_id,
                fact_type,
                value if value.get("status") in {"available", "stale"} else None,
                str(value.get("source") or source),
                str(value.get("status") or "missing"),
            )
        )
    return supplements


def _confirmed_profile_facts(value: Any) -> List[Dict[str, Any]]:
    return [
        _fact(
            "profile.{}".format(item["key"]),
            "user_confirmed_profile",
            item["value"],
            "用户核对确认",
            label=item["label"],
        )
        for item in normalize_profile_fields(value)
    ]


def _deduplicate_facts(facts: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    result = []
    seen = set()
    for item in facts:
        fact_id = item.get("id")
        if not fact_id or fact_id in seen:
            continue
        seen.add(fact_id)
        result.append(item)
    return result


def _fact_category(fact_id: str) -> str:
    if fact_id.startswith("bazi."):
        return "bazi"
    if fact_id.startswith("profile."):
        return "profile_details"
    if fact_id == "location.birth":
        return "birth_city"
    if fact_id == "location.current":
        return "current_city"
    if fact_id.startswith("environment.") or fact_id.startswith("calendar.solar_term"):
        return "environment_facts"
    if fact_id.startswith("history."):
        return "history_summary"
    return "unknown"


def _safe_model_text(value: Any, limit: int, label: str) -> str:
    text = _bounded(value, limit, label)
    if UNSAFE_OUTPUT.search(text) or HTML_LIKE.search(text):
        raise ValueError("模型输出包含不安全内容")
    return text


def _numbers(value: str) -> Set[str]:
    normalized = set()
    for token in re.findall(r"(?<![\w.])-?\d+(?:\.\d+)?", value):
        try:
            number = Decimal(token)
        except InvalidOperation:
            continue
        normalized.add("0" if number == 0 else format(number.normalize(), "f"))
    return normalized


def _fact_numbers(value: Any) -> Set[str]:
    if isinstance(value, bool) or value is None:
        return set()
    if isinstance(value, (int, float, Decimal)):
        return _numbers(str(value))
    if isinstance(value, str):
        return _numbers(value)
    if isinstance(value, dict):
        result: Set[str] = set()
        for item in value.values():
            result.update(_fact_numbers(item))
        return result
    if isinstance(value, (list, tuple, set)):
        result = set()
        for item in value:
            result.update(_fact_numbers(item))
        return result
    return set()


def _validate_evidence(
    ids: Any,
    facts: Dict[str, Dict[str, Any]],
    allowed_types: Set[str],
    text: str,
) -> List[str]:
    if not isinstance(ids, list) or not 1 <= len(ids) <= 8:
        raise ValueError("证据引用数量不正确")
    normalized = []
    for raw in ids:
        fact_id = str(raw or "").strip()
        fact = facts.get(fact_id)
        if (
            not fact
            or fact.get("status") not in {"available", "stale"}
            or fact.get("type") not in allowed_types
            or fact_id in normalized
        ):
            raise ValueError("证据引用无效")
        normalized.append(fact_id)
    evidence_numbers: Set[str] = set()
    for fact_id in normalized:
        evidence_numbers.update(_fact_numbers(facts[fact_id].get("value")))
    if not _numbers(text).issubset(evidence_numbers):
        raise ValueError("解释包含证据中不存在的数值")
    return normalized


def _validate_culture_section(
    raw: Any,
    section: str,
    facts: Dict[str, Dict[str, Any]],
) -> Dict[str, Any]:
    if not isinstance(raw, dict) or raw.get("traditional_culture") is not True:
        raise ValueError("传统文化章节格式不正确")
    text = _safe_model_text(raw.get("text"), 1400, "传统文化解释")
    evidence_ids = _validate_evidence(
        raw.get("evidence_ids"),
        facts,
        SECTION_EVIDENCE_TYPES[section],
        text,
    )
    return {"text": text, "evidence_ids": evidence_ids, "traditional_culture": True}


def _validate_action(raw: Any, facts: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError("行动格式不正确")
    kind = str(raw.get("kind") or "")
    if kind not in ALLOWED_ACTION_KINDS:
        raise ValueError("行动类型不正确")
    values = {
        "title": _safe_model_text(raw.get("title"), 100, "行动标题"),
        "detail": _safe_model_text(raw.get("detail"), 360, "行动内容"),
        "basis": _safe_model_text(raw.get("basis"), 240, "行动依据"),
        "observe": _safe_model_text(raw.get("observe"), 240, "观察点"),
        "uncertainty": _safe_model_text(raw.get("uncertainty"), 240, "不确定性"),
    }
    evidence_ids = _validate_evidence(
        raw.get("evidence_ids"),
        facts,
        ACTION_EVIDENCE_TYPES[kind],
        " ".join(values.values()),
    )
    return {
        "kind": kind,
        **values,
        "evidence_ids": evidence_ids,
        "traditional_culture": raw.get("traditional_culture") is True,
        "origin": "ai_interpretation",
    }


def validate_ai_interpretation(
    raw: Any,
    facts: List[Dict[str, Any]],
    has_question: bool,
) -> Dict[str, Any]:
    if not isinstance(raw, dict) or "facts" in raw or set(raw.keys()) != {"culture", "actions"}:
        raise ValueError("模型响应不得包含或改写事实层")
    fact_index = {fact["id"]: fact for fact in facts}
    culture_raw = raw.get("culture")
    if not isinstance(culture_raw, dict):
        raise ValueError("传统文化层格式不正确")
    culture = {
        section: _validate_culture_section(culture_raw.get(section), section, fact_index)
        for section in REQUIRED_CULTURE_SECTIONS
    }
    if has_question:
        culture["question"] = _validate_culture_section(culture_raw.get("question"), "question", fact_index)
    actions_raw = raw.get("actions")
    if not isinstance(actions_raw, list) or not 1 <= len(actions_raw) <= 6:
        raise ValueError("今日行动数量不正确")
    actions = []
    for raw_action in actions_raw:
        try:
            actions.append(_validate_action(raw_action, fact_index))
        except ValueError:
            continue
    if not actions:
        raise ValueError("没有通过证据校验的今日行动")
    return {"culture": culture, "actions": actions}


def _local_actions(facts: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    index = {item["id"]: item for item in facts}
    actions = []
    weather = index.get("environment.weather.current", {})
    if weather.get("status") in {"available", "stale"}:
        actions.append({
            "kind": "environment",
            "title": "按实时体感安排户外活动",
            "detail": "先查看当前温度、风和降水，再决定衣着与活动强度。",
            "basis": "现居城市环境观测",
            "evidence_ids": ["environment.weather.current"],
            "observe": "观察体感、风雨变化和当地预警",
            "uncertainty": "天气会变化，请以最新观测为准",
            "traditional_culture": False,
            "origin": "local_rule",
        })
    air = index.get("environment.air_quality.current", {})
    aqi = ((air.get("value") or {}).get("aqi") or {}).get("value") if isinstance(air.get("value"), dict) else None
    if isinstance(aqi, (int, float)) and aqi >= 100:
        actions.append({
            "kind": "environment",
            "title": "减少长时间高强度户外活动",
            "detail": "空气质量偏差时，可优先选择室内或较轻缓的活动。",
            "basis": "现居城市空气质量观测",
            "evidence_ids": ["environment.air_quality.current"],
            "observe": "观察个人体感并留意当地健康提示",
            "uncertainty": "个体感受不同，空气质量也会随时变化",
            "traditional_culture": False,
            "origin": "local_rule",
        })
    return actions[:3]


def generate_spring_wind(
    gateway: AIGateway,
    environment_gateway: Any,
    request: Dict[str, Any],
    *,
    now: Optional[datetime] = None,
) -> Dict[str, Any]:
    if not isinstance(request, dict):
        raise ValueError("请求格式不正确")
    bazi = _bounded(request.get("bazi"), 500, "八字")
    birth_city = _bounded(request.get("birth_city"), 80, "出生城市")
    current_city = _bounded(request.get("current_city"), 80, "现居城市")
    question = _bounded(request.get("question"), 500, "问事儿", required=False)
    browser_timezone = _bounded(
        request.get("browser_timezone") or "Asia/Shanghai",
        80,
        "浏览器时区",
    )
    consent_manifest = request.get("consent_manifest")
    environment_categories = _consent_categories(consent_manifest, "environment")
    ai_categories = _consent_categories(consent_manifest, "ai")

    parsed_bazi = parse_bazi(bazi)
    if not parsed_bazi["valid"]:
        raise ValueError("请输入完整、可识别的四柱八字")

    if {"birth_city", "current_city"}.issubset(environment_categories):
        snapshot = environment_gateway.build_snapshot(
            birth_city,
            current_city,
            birth_location_id=request.get("birth_location_id"),
            current_location_id=request.get("current_location_id"),
        )
    else:
        snapshot = _missing_environment_snapshot(birth_city, current_city, "environment_not_authorized")

    selected_current = ((snapshot.get("locations") or {}).get("current") or {}).get("selected")
    timezone_name = str((selected_current or {}).get("timezone") or browser_timezone)
    moment = now or datetime.now(timezone.utc)
    terms = solar_term_context(
        moment,
        timezone_name,
        fallback_timezone_name=browser_timezone,
        fallback_source="browser_timezone",
    )
    bazi_facts = [_safe_copy(fact) for fact in parsed_bazi["facts"]]
    profile_facts = _confirmed_profile_facts(request.get("profile_details"))
    calendar_facts = [
        _fact(
            terms[key]["id"],
            "deterministic_calendar",
            {field: terms[key].get(field) for field in ("name", "starts_at", "element", "advice", "classic")},
            terms[key]["source"],
            terms[key]["status"],
            source_version=terms[key]["source_version"],
        )
        for key in ("current", "next")
    ]
    external_facts = [
        fact for fact in (_normalize_external_fact(item) for item in snapshot.get("facts", [])) if fact
    ]
    context = _safe_copy(request.get("context") if isinstance(request.get("context"), dict) else {})
    facts = _deduplicate_facts(
        [*bazi_facts, *profile_facts, *calendar_facts, *external_facts, *_environment_fact_supplements(snapshot), *_history_facts(context)]
    )

    location_pending = snapshot.get("status") == "awaiting_confirmation"
    culture: Dict[str, Any]
    actions: List[Dict[str, Any]] = []
    ai_status = "not_requested"
    if location_pending:
        culture = {"status": "missing", "reason": "location_confirmation_required"}
    elif not ai_categories:
        culture = {"status": "missing", "reason": "ai_not_authorized"}
        actions = _local_actions(facts)
    else:
        ai_facts = [
            fact for fact in facts
            if _fact_category(fact["id"]) in ai_categories
        ]
        payload = {
            "facts": ai_facts,
            "question": question if "question" in ai_categories else None,
            "context_manifest": context.get("manifest"),
            "contract": {
                "facts_are_read_only": True,
                "required_culture_sections": list(REQUIRED_CULTURE_SECTIONS),
                "actions_require_evidence": True,
            },
        }
        try:
            raw = gateway.complete_json(
                _prompt(),
                "以下事实由程序生成，模型只能引用，不能改写：\n"
                + json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
                max_tokens=2200,
            )
            validated = validate_ai_interpretation(raw, ai_facts, bool(question and "question" in ai_categories))
            culture = validated["culture"]
            actions = validated["actions"]
            ai_status = "available"
        except AIProviderError as exc:
            ai_status = "missing"
            culture = {"status": "missing", "reason": str(exc)}
            actions = _local_actions(facts)
        except ValueError:
            ai_status = "invalid"
            culture = {"status": "missing", "reason": "ai_output_failed_validation"}
            actions = []

    if location_pending:
        status = "awaiting_confirmation"
    elif snapshot.get("status") != "complete" or ai_status != "available":
        status = "partial"
    else:
        status = "complete"
    generated_at = moment.astimezone(timezone.utc).isoformat(timespec="seconds")
    return {
        "version": REPORT_VERSION,
        "status": status,
        "date": terms["local_date"],
        "facts": facts,
        "culture": culture,
        "actions": actions,
        "question": question,
        "locations": snapshot.get("locations", {}),
        "environment_provider": snapshot.get("provider", {}),
        "metadata": {
            "fact_snapshot_version": FACT_SNAPSHOT_VERSION,
            "bazi_algorithm_version": parsed_bazi["algorithm_version"],
            "confirmed_profile_fields": len(profile_facts),
            "calendar_version": terms["calendar_version"],
            "timezone": terms["timezone"],
            "timezone_source": terms["timezone_source"],
            "environment_version": snapshot.get("version"),
            "environment_status": snapshot.get("status"),
            "ai_status": ai_status,
            "provider": getattr(gateway.config, "provider_name", "未配置"),
            "model": getattr(gateway.config, "text_model", ""),
            "generated_at": generated_at,
        },
        "disclaimer": "传统文化内容仅提供一种观察角度，不构成医疗诊断、吉凶定论或重大决策依据。",
    }
