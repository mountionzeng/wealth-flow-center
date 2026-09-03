"""Transient, OpenAI-compatible AI gateway with privacy-safe failures."""

from __future__ import annotations

import base64
from dataclasses import dataclass
import io
import json
import os
import re
import urllib.error
import urllib.request
from typing import Any, Callable, Dict, Optional

from PIL import Image, UnidentifiedImageError


MAX_IMAGE_BYTES = 5 * 1024 * 1024
MAX_IMAGE_SIDE = 4096
MAX_IMAGE_PIXELS = 16_000_000
SUPPORTED_IMAGES = {"image/jpeg", "image/png", "image/webp"}
PROFILE_FIELD_LABELS = {
    "gender": "性别",
    "solar_birth": "公历出生",
    "lunar_birth": "农历出生",
    "true_solar_time": "真太阳时",
    "birth_place": "出生地点",
    "zodiac": "生肖",
    "day_master": "日主",
    "five_elements": "五行摘要",
    "nayin": "纳音",
    "fate_palace": "命宫",
    "body_palace": "身宫",
    "start_luck": "起运信息",
}
PROFILE_CONFIDENCE = {"high", "medium", "low"}


def _timeout_from_env() -> int:
    try:
        value = int(os.getenv("BERICH_AI_TIMEOUT_SECONDS", "45").strip() or "45")
    except (AttributeError, TypeError, ValueError):
        return 45
    return max(5, min(90, value))


class AIProviderError(RuntimeError):
    """A privacy-safe provider error code suitable for HTTP mapping."""


@dataclass(frozen=True)
class ProviderConfig:
    provider_name: str = "未配置"
    base_url: str = ""
    api_key: str = ""
    text_model: str = ""
    vision_model: str = ""
    retention_policy: str = "尚未核实，请在发送前确认供应商条款"
    terms_version: str = "unknown"
    timeout_seconds: int = 45

    @classmethod
    def from_env(cls) -> "ProviderConfig":
        return cls(
            provider_name=os.getenv("BERICH_AI_PROVIDER_NAME", "未配置").strip() or "未配置",
            base_url=os.getenv("BERICH_AI_BASE_URL", "").strip(),
            api_key=os.getenv("BERICH_AI_API_KEY", "").strip(),
            text_model=os.getenv("BERICH_AI_TEXT_MODEL", "").strip(),
            vision_model=os.getenv("BERICH_AI_VISION_MODEL", "").strip(),
            retention_policy=os.getenv(
                "BERICH_AI_RETENTION_POLICY", "尚未核实，请在发送前确认供应商条款"
            ).strip(),
            terms_version=os.getenv("BERICH_AI_TERMS_VERSION", "unknown").strip() or "unknown",
            timeout_seconds=_timeout_from_env(),
        )

    @property
    def configured(self) -> bool:
        return bool(self.base_url and self.api_key and self.text_model)

    def disclosure(self) -> Dict[str, Any]:
        return {
            "provider_name": self.provider_name,
            "text_available": bool(self.configured),
            "vision_available": bool(self.configured and self.vision_model),
            "retention_policy": self.retention_policy,
            "terms_version": self.terms_version,
        }


@dataclass(frozen=True)
class SanitizedImage:
    data: bytes
    media_type: str
    width: int
    height: int


def _detected_media_type(data: bytes) -> Optional[str]:
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def sanitize_image(data: bytes, declared_type: str) -> SanitizedImage:
    if not isinstance(data, (bytes, bytearray)) or not data:
        raise ValueError("图片内容为空")
    if len(data) > MAX_IMAGE_BYTES:
        raise ValueError("图片不能超过 5 MB")
    normalized_type = str(declared_type or "").split(";", 1)[0].strip().lower()
    detected = _detected_media_type(bytes(data))
    if normalized_type not in SUPPORTED_IMAGES or detected != normalized_type:
        raise ValueError("只支持内容真实匹配的 JPEG、PNG 或 WebP 图片")

    try:
        with Image.open(io.BytesIO(data)) as probe:
            frames = int(getattr(probe, "n_frames", 1) or 1)
            width, height = probe.size
            if frames != 1:
                raise ValueError("暂不支持多帧或动画图片")
            if width <= 0 or height <= 0 or width > MAX_IMAGE_SIDE or height > MAX_IMAGE_SIDE:
                raise ValueError("图片尺寸超出限制")
            if width * height > MAX_IMAGE_PIXELS:
                raise ValueError("图片像素总量超出限制")
            probe.verify()

        with Image.open(io.BytesIO(data)) as image:
            image.load()
            output = io.BytesIO()
            if detected == "image/jpeg":
                cleaned = image.convert("RGB")
                cleaned.save(output, format="JPEG", quality=90, optimize=True)
                media_type = "image/jpeg"
            else:
                cleaned = image.convert("RGBA" if image.mode in {"RGBA", "LA"} else "RGB")
                cleaned.save(output, format="PNG", optimize=True)
                media_type = "image/png"
    except (UnidentifiedImageError, OSError) as exc:
        raise ValueError("图片损坏或无法解码") from exc

    cleaned_data = output.getvalue()
    if len(cleaned_data) > MAX_IMAGE_BYTES:
        raise ValueError("净化后的图片仍然过大")
    return SanitizedImage(cleaned_data, media_type, width, height)


Transport = Callable[[ProviderConfig, Dict[str, Any], int], Dict[str, Any]]


def _http_transport(config: ProviderConfig, payload: Dict[str, Any], timeout: int) -> Dict[str, Any]:
    endpoint = config.base_url.rstrip("/") + "/chat/completions"
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        endpoint,
        data=body,
        method="POST",
        headers={
            "Authorization": "Bearer " + config.api_key,
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read(2 * 1024 * 1024 + 1)
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise AIProviderError("provider_unavailable") from exc
    if len(raw) > 2 * 1024 * 1024:
        raise AIProviderError("provider_response_too_large")
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise AIProviderError("provider_invalid_response") from exc
    if not isinstance(parsed, dict):
        raise AIProviderError("provider_invalid_response")
    return parsed


def _extract_content(payload: Dict[str, Any]) -> str:
    try:
        content = payload["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise AIProviderError("provider_invalid_response") from exc
    if isinstance(content, list):
        content = "".join(str(item.get("text", "")) for item in content if isinstance(item, dict))
    if not isinstance(content, str) or not content.strip():
        raise AIProviderError("provider_empty_response")
    return content.strip()


def _parse_json_content(content: str) -> Dict[str, Any]:
    stripped = re.sub(r"^```(?:json)?\s*", "", content.strip(), flags=re.I)
    stripped = re.sub(r"\s*```$", "", stripped)
    match = re.search(r"\{[\s\S]*\}", stripped)
    if not match:
        raise AIProviderError("provider_invalid_json")
    try:
        parsed = json.loads(match.group(0))
    except json.JSONDecodeError as exc:
        raise AIProviderError("provider_invalid_json") from exc
    if not isinstance(parsed, dict):
        raise AIProviderError("provider_invalid_json")
    return parsed


def normalize_profile_fields(value: Any) -> list[Dict[str, str]]:
    """Keep only bounded, explicitly supported facts recognized from an image."""
    if not isinstance(value, list):
        return []
    result = []
    seen = set()
    for item in value[:24]:
        if not isinstance(item, dict):
            continue
        key = str(item.get("key") or "").strip()
        if key not in PROFILE_FIELD_LABELS or key in seen:
            continue
        field_value = str(item.get("value") or "").strip()
        if not field_value or len(field_value) > 160:
            continue
        if re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", field_value):
            continue
        confidence = str(item.get("confidence") or "medium").strip().lower()
        if confidence not in PROFILE_CONFIDENCE:
            confidence = "medium"
        result.append({
            "key": key,
            "label": PROFILE_FIELD_LABELS[key],
            "value": field_value,
            "confidence": confidence,
        })
        seen.add(key)
    return result


class AIGateway:
    def __init__(self, config: ProviderConfig, transport: Optional[Transport] = None):
        self.config = config
        self.transport = transport or _http_transport

    def disclosure(self) -> Dict[str, Any]:
        return self.config.disclosure()

    def _request(self, messages: list, model: str, max_tokens: int, response_format: Optional[dict] = None) -> str:
        if not self.config.configured:
            raise AIProviderError("provider_not_configured")
        payload: Dict[str, Any] = {
            "model": model,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": 0.4,
        }
        if response_format:
            payload["response_format"] = response_format
        try:
            response = self.transport(self.config, payload, self.config.timeout_seconds)
            return _extract_content(response)
        except AIProviderError:
            raise
        except Exception as exc:
            raise AIProviderError("provider_unavailable") from exc

    def complete_text(self, system: str, user: str, max_tokens: int = 1800) -> str:
        return self._request(
            [{"role": "system", "content": system}, {"role": "user", "content": user}],
            self.config.text_model,
            max_tokens,
        )

    def complete_json(self, system: str, user: str, max_tokens: int = 900) -> Dict[str, Any]:
        content = self._request(
            [{"role": "system", "content": system}, {"role": "user", "content": user}],
            self.config.text_model,
            max_tokens,
            {"type": "json_object"},
        )
        return _parse_json_content(content)

    def recognize_bazi(self, image: SanitizedImage) -> Dict[str, Any]:
        if not self.config.vision_model:
            raise AIProviderError("vision_not_configured")
        encoded = base64.b64encode(image.data).decode("ascii")
        prompt = (
            "识别图片里明确可见的命盘资料，不得根据四柱猜测图片没写出的个人信息。"
            "只返回 JSON，结构为："
            '{"bazi":"甲子年 丙寅月 壬午日 辛亥时","year_pillar":"甲子",'
            '"month_pillar":"丙寅","day_pillar":"壬午","hour_pillar":"辛亥",'
            '"profile_fields":[{"key":"gender","value":"女","confidence":"high"}]}。'
            "profile_fields 只允许这些 key：gender、solar_birth、lunar_birth、true_solar_time、"
            "birth_place、zodiac、day_master、five_elements、nayin、fate_palace、body_palace、start_luck。"
            "仅提取图片原文明确写出的值；confidence 只能是 high、medium、low。"
            "不输出姓名、手机号、证件号、联系方式，不推断健康、性格、旺衰、喜用神或吉凶。"
            "未识别到四柱时返回 {\"bazi\":null,\"error\":\"未能识别八字信息\"}。"
        )
        messages = [{
            "role": "user",
            "content": [
                {"type": "image_url", "image_url": {"url": "data:{};base64,{}".format(image.media_type, encoded)}},
                {"type": "text", "text": prompt},
            ],
        }]
        content = self._request(messages, self.config.vision_model, 800)
        parsed = _parse_json_content(content)
        if not str(parsed.get("bazi") or "").strip():
            raise AIProviderError("bazi_not_recognized")
        return {
            "bazi": str(parsed["bazi"]).strip()[:120],
            "year_pillar": parsed.get("year_pillar"),
            "month_pillar": parsed.get("month_pillar"),
            "day_pillar": parsed.get("day_pillar"),
            "hour_pillar": parsed.get("hour_pillar"),
            "profile_fields": normalize_profile_fields(parsed.get("profile_fields")),
            "source": "external_vision",
        }
