"""On-device macOS Vision OCR for BaZi screenshots."""

from __future__ import annotations

import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from datetime import datetime
from typing import Any, Callable, Dict, Iterable, List

from .ai_gateway import PROFILE_FIELD_LABELS, SanitizedImage, normalize_profile_fields


TIAN_GAN = set("甲乙丙丁戊己庚辛壬癸")
DI_ZHI = set("子丑寅卯辰巳午未申酉戌亥")
GAN_ORDER = "甲乙丙丁戊己庚辛壬癸"
ZHI_ORDER = "子丑寅卯辰巳午未申酉戌亥"
PILLAR_LABELS = ("年", "月", "日", "时")
SWIFT_HELPER = Path(__file__).resolve().parent.parent / "scripts" / "recognize_bazi_text.swift"


class LocalVisionError(RuntimeError):
    """Privacy-safe local recognition failure."""


def _format_pillars(pillars: Iterable[str]) -> str:
    values = list(pillars)[:4]
    return " ".join(f"{pillar}{label}" for pillar, label in zip(values, PILLAR_LABELS))


def _row_groups(observations: List[Dict[str, Any]], tolerance: float = 0.022) -> List[List[Dict[str, Any]]]:
    rows: List[List[Dict[str, Any]]] = []
    for item in sorted(observations, key=lambda row: -float(row.get("y", 0))):
        y = float(item.get("y", 0))
        target = next((row for row in rows if abs(float(row[0].get("y", 0)) - y) <= tolerance), None)
        if target is None:
            rows.append([item])
        else:
            target.append(item)
    return [sorted(row, key=lambda item: float(item.get("x", 0))) for row in rows]


def _chars_in_row(row: List[Dict[str, Any]], allowed: set[str]) -> List[tuple[float, str]]:
    values: List[tuple[float, str]] = []
    for item in row:
        text = str(item.get("text", "")).strip()
        x = float(item.get("x", 0))
        chars = [char for char in text if char in allowed]
        for index, char in enumerate(chars):
            values.append((x + index * 0.001, char))
    return sorted(values)


def _julian_day(year: int, month: int, day: int) -> int:
    shift = (14 - month) // 12
    adjusted_year = year + 4800 - shift
    adjusted_month = month + 12 * shift - 3
    return day + (153 * adjusted_month + 2) // 5 + 365 * adjusted_year + adjusted_year // 4 - adjusted_year // 100 + adjusted_year // 400 - 32045


def _month_order(value: datetime) -> int:
    boundaries = (
        (1, 6, 11), (2, 4, 0), (3, 6, 1), (4, 5, 2),
        (5, 6, 3), (6, 6, 4), (7, 7, 5), (8, 7, 6),
        (9, 8, 7), (10, 8, 8), (11, 7, 9), (12, 7, 10),
    )
    order = 10
    for month, day, candidate in boundaries:
        if (value.month, value.day) >= (month, day):
            order = candidate
    return order


def _bazi_from_solar_time(value: datetime) -> str:
    solar_year = value.year - 1 if (value.month, value.day) < (2, 4) else value.year
    year_index = (solar_year - 4) % 60
    year_pillar = GAN_ORDER[year_index % 10] + ZHI_ORDER[year_index % 12]

    month_order = _month_order(value)
    month_gan = GAN_ORDER[((year_index % 10) % 5 * 2 + 2 + month_order) % 10]
    month_zhi = ZHI_ORDER[(2 + month_order) % 12]

    day_index = (_julian_day(value.year, value.month, value.day) + 49) % 60
    day_pillar = GAN_ORDER[day_index % 10] + ZHI_ORDER[day_index % 12]

    hour_zhi_index = ((value.hour + 1) // 2) % 12
    hour_gan_index = ((day_index % 10) % 5 * 2 + hour_zhi_index) % 10
    hour_pillar = GAN_ORDER[hour_gan_index] + ZHI_ORDER[hour_zhi_index]
    return _format_pillars((year_pillar, month_gan + month_zhi, day_pillar, hour_pillar))


def extract_bazi_from_observations(observations: List[Dict[str, Any]]) -> str:
    """Extract four pillars from OCR boxes, preferring aligned table rows."""
    cleaned = [item for item in observations if isinstance(item, dict) and str(item.get("text", "")).strip()]
    rows = _row_groups(cleaned)
    for index, row in enumerate(rows):
        stems = _chars_in_row(row, TIAN_GAN)
        if len(stems) != 4:
            continue
        for branch_row in rows[index + 1:index + 4]:
            branches = _chars_in_row(branch_row, DI_ZHI)
            if len(branches) != 4:
                continue
            if max(abs(stems[column][0] - branches[column][0]) for column in range(4)) > 0.12:
                continue
            return _format_pillars(stems[column][1] + branches[column][1] for column in range(4))

    combined = " ".join(str(item.get("text", "")) for item in cleaned)
    inline = re.findall(r"([甲乙丙丁戊己庚辛壬癸][子丑寅卯辰巳午未申酉戌亥])", combined)
    if len(inline) >= 4:
        return _format_pillars(inline[:4])
    solar_time = re.search(
        r"((?:19|20)\d{2})[年./-](\d{1,2})[月./-](\d{1,2})日?\s+(\d{1,2}):(\d{2})",
        combined,
    )
    if solar_time:
        try:
            value = datetime(*(int(part) for part in solar_time.groups()))
        except ValueError:
            pass
        else:
            return _bazi_from_solar_time(value)
    raise LocalVisionError("本机已读到图片，但没有可靠识别出四柱；请换一张更清晰、包含年柱月柱日柱时柱的截图")


PROFILE_LABEL_ALIASES = {
    "gender": ("性别",),
    "solar_birth": ("公历出生", "阳历出生", "公历", "阳历"),
    "lunar_birth": ("农历出生", "阴历出生", "农历", "阴历"),
    "true_solar_time": ("真太阳时",),
    "birth_place": ("出生地点", "出生地", "出生城市"),
    "zodiac": ("生肖", "属相"),
    "day_master": ("日主", "日元"),
    "five_elements": ("五行摘要", "五行"),
    "nayin": ("纳音",),
    "fate_palace": ("命宫",),
    "body_palace": ("身宫",),
    "start_luck": ("起运信息", "起运"),
}
NAYIN_VALUES = {
    "海中金", "炉中火", "大林木", "路旁土", "剑锋金", "山头火", "涧下水", "城头土", "白蜡金", "杨柳木",
    "泉中水", "屋上土", "霹雳火", "松柏木", "长流水", "沙中金", "山下火", "平地木", "壁上土", "金箔金",
    "覆灯火", "佛灯火", "天河水", "大驿土", "钗钏金", "桑柘木", "大溪水", "沙中土", "天上火", "石榴木", "大海水",
}


def _clean_profile_value(key: str, value: str) -> str:
    cleaned = str(value or "").strip(" ，,。;；|｜")
    if key in {"solar_birth", "true_solar_time"}:
        timestamp = re.search(
            r"((?:19|20)\d{2}[年./-]\d{1,2}[月./-]\d{1,2}日?(?:\s+\d{1,2}:\d{2})?)",
            cleaned,
        )
        if timestamp:
            return timestamp.group(1)
    return re.sub(r"^[^0-9A-Za-z\u3400-\u9fff]+", "", cleaned).strip()


def extract_profile_from_observations(observations: List[Dict[str, Any]]) -> List[Dict[str, str]]:
    """Extract only explicitly labelled profile values from local OCR rows."""
    cleaned = [item for item in observations if isinstance(item, dict) and str(item.get("text", "")).strip()]
    lines = [" ".join(str(item.get("text", "")).strip() for item in row) for row in _row_groups(cleaned)]
    fields = []
    for key, aliases in PROFILE_LABEL_ALIASES.items():
        alias_pattern = "|".join(re.escape(alias) for alias in sorted(aliases, key=len, reverse=True))
        for line in lines:
            match = re.search(
                r"(?:^|[|｜;；])\s*(?:{})\s*[:：]?\s*(.+?)\s*$".format(alias_pattern),
                line,
            )
            if not match:
                continue
            value = re.split(
                r"\s+(?:(?:性别|公历出生|阳历出生|农历出生|阴历出生|真太阳时|出生地点|出生地|出生城市|生肖|属相|日主|日元|五行摘要|五行|纳音|命宫|身宫|起运信息|起运)\s*[:：])",
                match.group(1).strip(),
                maxsplit=1,
            )[0]
            value = _clean_profile_value(key, value)
            if value and value not in PROFILE_FIELD_LABELS.values():
                fields.append({"key": key, "value": value[:160], "confidence": "medium"})
                break
    if not any(item["key"] == "nayin" for item in fields):
        nayin = [
            str(item.get("text", "")).strip()
            for item in sorted(cleaned, key=lambda row: float(row.get("x", 0)))
            if str(item.get("text", "")).strip() in NAYIN_VALUES
        ]
        unique_nayin = list(dict.fromkeys(nayin))[:4]
        if unique_nayin:
            fields.append({"key": "nayin", "value": " · ".join(unique_nayin), "confidence": "medium"})
    return normalize_profile_fields(fields)


Runner = Callable[..., subprocess.CompletedProcess]


class LocalVisionOCR:
    def __init__(self, runner: Runner = subprocess.run, helper: Path = SWIFT_HELPER):
        self.runner = runner
        self.helper = helper

    def available(self) -> bool:
        return sys.platform == "darwin" and Path("/usr/bin/xcrun").exists() and self.helper.is_file()

    def recognize_bazi(self, image: SanitizedImage) -> Dict[str, Any]:
        if not self.available():
            raise LocalVisionError("这台设备暂不支持本机图片识别")
        suffix = ".jpg" if image.media_type == "image/jpeg" else ".png"
        path: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(prefix="berich-bazi-", suffix=suffix, delete=False) as handle:
                handle.write(image.data)
                path = Path(handle.name)
            result = self.runner(
                ["/usr/bin/xcrun", "swift", str(self.helper), str(path)],
                check=False,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=45,
            )
            if result.returncode != 0:
                raise LocalVisionError("本机图片识别暂时失败，请稍后重试")
            payload = json.loads(result.stdout.decode("utf-8"))
            observations = payload.get("observations") if isinstance(payload, dict) else None
            if not isinstance(observations, list):
                raise LocalVisionError("本机图片识别没有返回可用文字")
            return {
                "bazi": extract_bazi_from_observations(observations),
                "profile_fields": extract_profile_from_observations(observations),
                "source": "macos_vision",
            }
        except subprocess.TimeoutExpired as exc:
            raise LocalVisionError("本机图片识别超时，请换一张较小的截图") from exc
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            raise LocalVisionError("本机图片识别暂时失败，请稍后重试") from exc
        finally:
            if path is not None:
                path.unlink(missing_ok=True)
