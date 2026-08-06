"""Pure, auditable BaZi and solar-term fact helpers.

The BaZi parser deliberately describes only the four visible stems and
branches supplied by the user.  Solar-term timestamps come from the pinned
``lunar_python`` calendar library and are converted from the library's China
standard-time ephemeris into the confirmed current-city timezone.
"""

from __future__ import annotations

from datetime import date, datetime
import re
from typing import Any, Dict, List
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from lunar_python import Solar


TIAN_GAN = ("甲", "乙", "丙", "丁", "戊", "己", "庚", "辛", "壬", "癸")
DI_ZHI = ("子", "丑", "寅", "卯", "辰", "巳", "午", "未", "申", "酉", "戌", "亥")
SEXAGENARY_PAIRS = frozenset(
    TIAN_GAN[index % len(TIAN_GAN)] + DI_ZHI[index % len(DI_ZHI)]
    for index in range(60)
)
GAN_WUXING = {
    "甲": "木", "乙": "木", "丙": "火", "丁": "火", "戊": "土",
    "己": "土", "庚": "金", "辛": "金", "壬": "水", "癸": "水",
}
ZHI_WUXING = {
    "子": "水", "丑": "土", "寅": "木", "卯": "木", "辰": "土", "巳": "火",
    "午": "火", "未": "土", "申": "金", "酉": "金", "戌": "土", "亥": "水",
}
WUXING_COLORS = {
    "金": {"colors": ["白色", "银色", "金色"], "meaning": "金主义，收敛肃杀"},
    "木": {"colors": ["绿色", "青色", "翠色"], "meaning": "木主仁，生发向上"},
    "水": {"colors": ["黑色", "深蓝", "藏青"], "meaning": "水主智，润下藏纳"},
    "火": {"colors": ["红色", "紫色", "橙色"], "meaning": "火主礼，炎上光明"},
    "土": {"colors": ["黄色", "棕色", "米色"], "meaning": "土主信，厚德载物"},
}
WUXING_SHENG = {"金": "水", "水": "木", "木": "火", "火": "土", "土": "金"}
WUXING_KE = {"金": "木", "木": "土", "土": "水", "水": "火", "火": "金"}

BAZI_FACTS_VERSION = "bazi-facts-1.0.0"
CALENDAR_VERSION = "lunar_python@1.4.8"
VISIBLE_ELEMENTS_METHOD = "visible_stems_branches"
VISIBLE_ELEMENTS_SCOPE = "只统计用户输入的显性天干与地支，不含藏干，不判断旺衰、强弱或用神。"
LIBRARY_TIMEZONE = ZoneInfo("Asia/Shanghai")

JIEQI = (
    ("小寒", 1, 5, "水", "寒气渐盛，宜藏不宜露", "《月令七十二候集解》：小寒，十二月节。"),
    ("大寒", 1, 20, "水", "一年最冷，温补固本", "《授时通考》：大寒为中者，上形于小寒，故谓之大。"),
    ("立春", 2, 4, "木", "春气始生，宜舒展条达", "《黄帝内经》：春三月，此谓发陈，天地俱生。"),
    ("雨水", 2, 19, "木", "冰雪消融，养脾祛湿", "《月令七十二候集解》：天一生水，生木者必水也。"),
    ("惊蛰", 3, 6, "木", "春雷始鸣，万物复苏", "《月令七十二候集解》：万物出乎震，震为雷。"),
    ("春分", 3, 21, "木", "阴阳平衡，起居有常", "《春秋繁露》：春分者，阴阳相半也。"),
    ("清明", 4, 5, "木", "天清地明，宜踏青疏肝", "《岁时百问》：万物生长此时，皆清洁而明净。"),
    ("谷雨", 4, 20, "土", "雨生百谷，湿重健脾", "《通纬》：谷雨，雨水生百谷。"),
    ("立夏", 5, 6, "火", "夏气渐升，养心安神", "《黄帝内经》：夏三月，此谓蕃秀。"),
    ("小满", 5, 21, "火", "小得盈满，清热祛湿", "《月令七十二候集解》：物至于此小得盈满。"),
    ("芒种", 6, 6, "火", "有芒之种，忙而不乱", "《月令七十二候集解》：有芒之种谷可稼种矣。"),
    ("夏至", 6, 21, "火", "阳极阴生，静心养阳", "《恪遵宪度》：日北至，日长之至。"),
    ("小暑", 7, 7, "火", "暑气渐盛，养心防暑", "《月令七十二候集解》：暑，热也。"),
    ("大暑", 7, 23, "土", "一年最热，避暑养阴", "《月令七十二候集解》：大者，乃炎热之极也。"),
    ("立秋", 8, 7, "金", "秋气始收，润肺防燥", "《黄帝内经》：秋三月，此谓容平。"),
    ("处暑", 8, 23, "金", "暑气将退，滋阴润燥", "《月令七十二候集解》：处，止也，暑气至此而止。"),
    ("白露", 9, 8, "金", "露凝为白，防寒保暖", "《月令七十二候集解》：水土湿气凝而为露。"),
    ("秋分", 9, 23, "金", "阴阳各半，平和为要", "《春秋繁露》：秋分者，阴阳相半也。"),
    ("寒露", 10, 8, "水", "露气寒凉，添衣御寒", "《月令七十二候集解》：露气寒冷，将凝结也。"),
    ("霜降", 10, 23, "土", "霜始降，宜温养", "《二十四节气解》：气肃而霜降，阴始凝也。"),
    ("立冬", 11, 7, "水", "冬气始至，藏精养肾", "《黄帝内经》：冬三月，此谓闭藏。"),
    ("小雪", 11, 22, "水", "寒未深，宜温润", "《月令七十二候集解》：雨下而为寒气所薄，故凝而为雪。"),
    ("大雪", 12, 7, "水", "大雪渐盛，滋补御寒", "《月令七十二候集解》：大者，盛也。"),
    ("冬至", 12, 22, "水", "阴极阳生，一阳初动", "《恪遵宪度》：阴极之至，阳气始生。"),
)
JIEQI_BY_NAME = {row[0]: row for row in JIEQI}


def _jieqi_metadata(name: str) -> Dict[str, Any]:
    row = JIEQI_BY_NAME.get(name)
    if not row:
        return {"element": None, "advice": None, "classic": None}
    return {"element": row[3], "advice": row[4], "classic": row[5]}


def day_ganzhi(value: date) -> Dict[str, str]:
    base = date(1900, 1, 1)
    index = (value - base).days % 60
    gan = TIAN_GAN[index % 10]
    zhi = DI_ZHI[index % 12]
    return {"gan": gan, "zhi": zhi, "wuxing_gan": GAN_WUXING[gan], "wuxing_zhi": ZHI_WUXING[zhi]}


def month_ganzhi(value: date) -> Dict[str, str]:
    month = value.month
    zhi = DI_ZHI[(month + 1) % 12]
    year_gan_index = (value.year - 4) % 10
    gan = TIAN_GAN[((year_gan_index % 5) * 2 + month - 1) % 10]
    return {"gan": gan, "zhi": zhi}


def parse_bazi(raw: str) -> Dict[str, Any]:
    text = str(raw or "").strip()
    pair_pattern = re.compile("[{}][{}]".format("".join(TIAN_GAN), "".join(DI_ZHI)))
    matches = list(pair_pattern.finditer(text))
    pillars: List[Dict[str, str]] = []
    for match in matches:
        pair = match.group(0)
        pillars.append({"gan": pair[0], "zhi": pair[1], "text": pair})

    residue = pair_pattern.sub("", text)
    residue = re.sub(r"[年月日时柱\s,，、·/|;；:：._—-]+", "", residue)
    has_illegal_content = bool(residue)
    invalid_pairs = [pillar["text"] for pillar in pillars if pillar["text"] not in SEXAGENARY_PAIRS]
    complete = len(pillars) == 4 and not has_illegal_content and not invalid_pairs
    if complete:
        status = "complete"
        errors: List[str] = []
    elif invalid_pairs:
        status = "invalid"
        errors = ["存在不属于六十甲子的干支组合：{}。".format("、".join(invalid_pairs))]
    elif len(pillars) > 4:
        status = "invalid"
        errors = ["八字只能包含四柱，请删除多余内容后重试。"]
    elif has_illegal_content or not pillars:
        status = "invalid"
        errors = ["未识别到有效的四柱格式，请按“甲子 丙寅 壬午 辛亥”输入。"]
    else:
        status = "partial"
        errors = ["八字需完整包含年、月、日、时四柱；已保留当前识别结果。"]

    master = pillars[2]["gan"] if complete else None
    counts = {element: 0 for element in ("金", "木", "水", "火", "土")}
    for pillar in pillars:
        counts[GAN_WUXING[pillar["gan"]]] += 1
        counts[ZHI_WUXING[pillar["zhi"]]] += 1

    normalized = " ".join(pillar["text"] for pillar in pillars)
    facts = [
        {
            "id": "bazi.pillars.visible",
            "type": "user_input",
            "value": [pillar["text"] for pillar in pillars],
            "source": "用户输入",
            "method": "strict_visible_four_pillars",
            "status": "available" if complete else status,
        },
        {
            "id": "bazi.day_master",
            "type": "deterministic_calendar",
            "value": master,
            "source": "用户输入的日柱天干",
            "method": "third_visible_pillar_stem",
            "status": "available" if master else "missing",
        },
        {
            "id": "bazi.elements.visible",
            "type": "deterministic_calendar",
            "value": counts,
            "source": "用户输入",
            "method": VISIBLE_ELEMENTS_METHOD,
            "status": "available" if complete else status,
        },
    ]
    return {
        "valid": complete,
        "complete": complete,
        "status": status,
        "errors": errors,
        "normalized": normalized,
        "pillars": pillars,
        "day_master": master,
        "day_master_wuxing": GAN_WUXING.get(master) if master else None,
        "five_elements": {
            "counts": counts,
            "total": sum(counts.values()),
            "method": VISIBLE_ELEMENTS_METHOD,
            "method_version": "1.0.0",
            "scope": VISIBLE_ELEMENTS_SCOPE,
        },
        "algorithm_version": BAZI_FACTS_VERSION,
        "facts": facts,
    }


def _resolve_timezone(
    timezone_name: str,
    fallback_timezone_name: str,
    fallback_source: str,
) -> tuple:
    try:
        return ZoneInfo(str(timezone_name or "")), "confirmed_current_city"
    except (ZoneInfoNotFoundError, ValueError):
        try:
            return ZoneInfo(str(fallback_timezone_name or "")), "fallback:{}".format(fallback_source)
        except (ZoneInfoNotFoundError, ValueError):
            return ZoneInfo("UTC"), "fallback:utc"


def _solar_datetime(solar: Solar) -> datetime:
    return datetime(
        solar.getYear(),
        solar.getMonth(),
        solar.getDay(),
        solar.getHour(),
        solar.getMinute(),
        solar.getSecond(),
        tzinfo=LIBRARY_TIMEZONE,
    )


def _solar_term_item(jieqi: Any, timezone: ZoneInfo, fact_id: str) -> Dict[str, Any]:
    name = jieqi.getName()
    starts_at = _solar_datetime(jieqi.getSolar()).astimezone(timezone)
    return {
        "id": fact_id,
        "type": "deterministic_calendar",
        "name": name,
        "starts_at": starts_at.isoformat(timespec="seconds"),
        "source": "lunar_python solar-term ephemeris",
        "source_version": CALENDAR_VERSION,
        "status": "available",
        **_jieqi_metadata(name),
    }


def solar_term_context(
    value: Any,
    timezone_name: str,
    *,
    fallback_timezone_name: str = "Asia/Shanghai",
    fallback_source: str = "browser_timezone",
) -> Dict[str, Any]:
    """Return current and next solar terms for an explicit local timezone."""

    selected_timezone, timezone_source = _resolve_timezone(
        timezone_name,
        fallback_timezone_name,
        fallback_source,
    )
    if isinstance(value, datetime):
        local_value = value.replace(tzinfo=selected_timezone) if value.tzinfo is None else value.astimezone(selected_timezone)
    elif isinstance(value, date):
        local_value = datetime(value.year, value.month, value.day, 12, tzinfo=selected_timezone)
    else:
        raise TypeError("value must be a date or datetime")

    library_value = local_value.astimezone(LIBRARY_TIMEZONE)
    solar = Solar.fromYmdHms(
        library_value.year,
        library_value.month,
        library_value.day,
        library_value.hour,
        library_value.minute,
        library_value.second,
    )
    lunar = solar.getLunar()
    current = lunar.getPrevJieQi(False)
    next_term = lunar.getNextJieQi(False)
    if current is None or next_term is None:
        raise ValueError("历法库未返回当前或下一节气")
    return {
        "current": _solar_term_item(current, selected_timezone, "calendar.solar_term.current"),
        "next": _solar_term_item(next_term, selected_timezone, "calendar.solar_term.next"),
        "local_date": local_value.date().isoformat(),
        "timezone": selected_timezone.key,
        "timezone_source": timezone_source,
        "computed_at": local_value.isoformat(timespec="seconds"),
        "calendar_version": CALENDAR_VERSION,
    }


def current_jieqi(
    value: Any,
    timezone_name: str = "Asia/Shanghai",
) -> Dict[str, Any]:
    """Backward-compatible current-term helper backed by exact term time."""

    return solar_term_context(value, timezone_name)["current"]


def direction_advice(day_wuxing: str) -> Dict[str, Any]:
    sheng = {"金": "土", "木": "水", "水": "金", "火": "木", "土": "火"}
    ke = {"金": "火", "木": "金", "水": "土", "火": "水", "土": "木"}
    directions = {
        "金": ["西", "西北"], "木": ["东", "东南"], "水": ["北"],
        "火": ["南"], "土": ["中", "东北", "西南"],
    }
    if day_wuxing not in sheng:
        day_wuxing = "木"
    lucky_element = sheng[day_wuxing]
    avoid_element = ke[day_wuxing]
    return {
        "lucky": directions[lucky_element],
        "avoid": directions[avoid_element],
        "detail": "日主属{}，{}生{}为助，{}克{}需缓。".format(
            day_wuxing, lucky_element, day_wuxing, avoid_element, day_wuxing
        ),
    }


def today_context(value: Any, timezone_name: str = "Asia/Shanghai") -> Dict[str, Any]:
    solar_terms = solar_term_context(value, timezone_name)
    local_date = date.fromisoformat(solar_terms["local_date"])
    return {
        "date": local_date.isoformat(),
        "timezone": solar_terms["timezone"],
        "timezone_source": solar_terms["timezone_source"],
        "day_ganzhi": day_ganzhi(local_date),
        "month_ganzhi": month_ganzhi(local_date),
        "jieqi": solar_terms["current"],
        "solar_terms": solar_terms,
    }
