"""City-level Open-Meteo adapter with injectable I/O and auditable facts."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import hashlib
import json
import math
from typing import Any, Callable, Dict, Iterable, Optional, Tuple
import urllib.error
import urllib.parse
import urllib.request
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


ENVIRONMENT_VERSION = "environment-facts-1.0.0"
ALLOWED_HOSTS = {
    "geocoding-api.open-meteo.com",
    "api.open-meteo.com",
    "air-quality-api.open-meteo.com",
    "archive-api.open-meteo.com",
}
MAX_RESPONSE_BYTES = {
    "geocoding": 256 * 1024,
    "forecast": 512 * 1024,
    "air_quality": 256 * 1024,
    "historical": 1024 * 1024,
}
CACHE_TTLS = {
    "geocoding": timedelta(days=7),
    "forecast": timedelta(minutes=15),
    "air_quality": timedelta(hours=1),
    "historical": timedelta(hours=24),
}
WEATHER_LABELS = {
    0: "晴",
    1: "大致晴朗",
    2: "局部多云",
    3: "阴",
    45: "雾",
    48: "雾凇",
    51: "轻微毛毛雨",
    53: "毛毛雨",
    55: "较强毛毛雨",
    61: "小雨",
    63: "中雨",
    65: "大雨",
    71: "小雪",
    73: "中雪",
    75: "大雪",
    80: "阵雨",
    81: "较强阵雨",
    82: "强阵雨",
    95: "雷暴",
    96: "雷暴伴小冰雹",
    99: "雷暴伴冰雹",
}

_CHINESE_PROVINCES = (
    "河北", "山西", "辽宁", "吉林", "黑龙江", "江苏", "浙江", "安徽", "福建",
    "江西", "山东", "河南", "湖北", "湖南", "广东", "海南", "四川", "贵州",
    "云南", "陕西", "甘肃", "青海", "台湾",
)
_CHINESE_MUNICIPALITIES = ("北京", "天津", "上海", "重庆")
_CHINESE_ADMIN_PREFIXES = tuple(sorted(
    [(f"{name}省", name) for name in _CHINESE_PROVINCES]
    + [(name, name) for name in _CHINESE_PROVINCES]
    + [(f"{name}市", name) for name in _CHINESE_MUNICIPALITIES]
    + [(name, name) for name in _CHINESE_MUNICIPALITIES]
    + [
        ("内蒙古自治区", "内蒙古"), ("内蒙古", "内蒙古"),
        ("广西壮族自治区", "广西"), ("广西", "广西"),
        ("西藏自治区", "西藏"), ("西藏", "西藏"),
        ("宁夏回族自治区", "宁夏"), ("宁夏", "宁夏"),
        ("新疆维吾尔自治区", "新疆"), ("新疆", "新疆"),
        ("香港特别行政区", "香港"), ("香港", "香港"),
        ("澳门特别行政区", "澳门"), ("澳门", "澳门"),
    ],
    key=lambda item: len(item[0]),
    reverse=True,
))


class EnvironmentProviderError(RuntimeError):
    """Privacy-safe provider error suitable for partial-result mapping."""


@dataclass(frozen=True)
class EnvironmentProviderConfig:
    provider_name: str = "Open-Meteo"
    geocoding_url: str = "https://geocoding-api.open-meteo.com/v1/search"
    forecast_url: str = "https://api.open-meteo.com/v1/forecast"
    air_quality_url: str = "https://air-quality-api.open-meteo.com/v1/air-quality"
    historical_url: str = "https://archive-api.open-meteo.com/v1/archive"
    timeout_seconds: int = 8
    user_agent: str = "BerichLocal/1.0 (local environment facts)"

    @property
    def endpoints(self) -> Dict[str, str]:
        return {
            "geocoding": self.geocoding_url,
            "forecast": self.forecast_url,
            "air_quality": self.air_quality_url,
            "historical": self.historical_url,
        }


@dataclass
class _CacheEntry:
    value: Dict[str, Any]
    fetched_at: datetime


Transport = Callable[
    [EnvironmentProviderConfig, str, Dict[str, Any], int, int],
    Dict[str, Any],
]


def _validate_provider_config(config: EnvironmentProviderConfig) -> None:
    for url in config.endpoints.values():
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme != "https" or parsed.hostname not in ALLOWED_HOSTS:
            raise EnvironmentProviderError("provider_configuration_invalid")
    if not config.user_agent.strip():
        raise EnvironmentProviderError("provider_configuration_invalid")


class _RejectRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Reject redirects before urllib can connect to the target host."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        raise EnvironmentProviderError("provider_redirect_rejected")


_SAFE_OPENER = urllib.request.build_opener(_RejectRedirectHandler())


def _http_transport(
    config: EnvironmentProviderConfig,
    endpoint: str,
    params: Dict[str, Any],
    timeout: int,
    max_bytes: int,
) -> Dict[str, Any]:
    if endpoint not in config.endpoints:
        raise EnvironmentProviderError("provider_endpoint_invalid")
    url = config.endpoints[endpoint] + "?" + urllib.parse.urlencode(params)
    request = urllib.request.Request(
        url,
        method="GET",
        headers={"Accept": "application/json", "User-Agent": config.user_agent},
    )
    try:
        with _SAFE_OPENER.open(request, timeout=timeout) as response:
            final_url = urllib.parse.urlparse(response.geturl())
            if final_url.scheme != "https" or final_url.hostname not in ALLOWED_HOSTS:
                raise EnvironmentProviderError("provider_redirect_rejected")
            raw = response.read(max_bytes + 1)
    except EnvironmentProviderError:
        raise
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise EnvironmentProviderError("provider_unavailable") from exc
    if len(raw) > max_bytes:
        raise EnvironmentProviderError("provider_response_too_large")
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise EnvironmentProviderError("provider_invalid_response") from exc
    if not isinstance(value, dict):
        raise EnvironmentProviderError("provider_invalid_response")
    return value


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _aware_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _number(value: Any) -> Optional[float]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if math.isfinite(number) else None


def _display_number(value: Any) -> Optional[Any]:
    number = _number(value)
    if number is None:
        return None
    return int(number) if number.is_integer() else round(number, 2)


def _bounded_city(value: Any) -> str:
    text = str(value or "").strip()
    if not text or len(text) > 80:
        raise ValueError("城市名称不能为空且不能超过 80 个字符")
    if any(ord(char) < 32 for char in text):
        raise ValueError("城市名称包含不支持的控制字符")
    return text


def _administrative_key(value: Any) -> str:
    text = "".join(str(value or "").split())
    for suffix in ("特别行政区", "维吾尔自治区", "壮族自治区", "回族自治区", "自治区", "省", "市"):
        if text.endswith(suffix) and len(text) > len(suffix):
            return text[:-len(suffix)]
    return text


def _qualified_chinese_city(city: str) -> Tuple[str, Optional[str]]:
    compact = "".join(city.split())
    for prefix, region in _CHINESE_ADMIN_PREFIXES:
        if not compact.startswith(prefix) or len(compact) <= len(prefix):
            continue
        locality = compact[len(prefix):]
        for suffix in ("自治州", "地区", "盟", "市", "区", "县"):
            if locality.endswith(suffix) and len(locality) > len(suffix):
                locality = locality[:-len(suffix)]
                break
        if locality:
            return locality, region
    return city, None


def _location_id(item: Dict[str, Any]) -> str:
    identity = "|".join(
        str(item.get(field) or "").strip()
        for field in ("name", "admin1", "country", "latitude", "longitude", "timezone")
    )
    return "openmeteo:" + hashlib.sha256(identity.encode("utf-8")).hexdigest()[:16]


def _normalize_location(item: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(item, dict):
        return None
    name = str(item.get("name") or "").strip()
    country = str(item.get("country") or "").strip()
    latitude = _number(item.get("latitude"))
    longitude = _number(item.get("longitude"))
    timezone_name = str(item.get("timezone") or "").strip()
    if not name or not country or latitude is None or longitude is None:
        return None
    try:
        ZoneInfo(timezone_name)
    except (ZoneInfoNotFoundError, ValueError):
        return None
    if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
        return None
    normalized = {
        "name": name,
        "admin1": str(item.get("admin1") or "").strip(),
        "country": country,
        "country_code": str(item.get("country_code") or "").strip().upper(),
        "latitude": round(latitude, 5),
        "longitude": round(longitude, 5),
        "timezone": timezone_name,
        "provider": "Open-Meteo Geocoding",
        "provider_version": "v1",
    }
    normalized["id"] = _location_id(normalized)
    normalized["label"] = " · ".join(
        part for part in (normalized["name"], normalized["admin1"], normalized["country"]) if part
    )
    return normalized


def _unit(value: Any, unit: Any) -> Dict[str, Any]:
    return {"value": _display_number(value), "unit": str(unit or "")}


def _mean(values: Iterable[Any]) -> Optional[float]:
    numbers = [number for number in (_number(value) for value in values) if number is not None]
    if not numbers:
        return None
    return round(sum(numbers) / len(numbers), 2)


class EnvironmentGateway:
    def __init__(
        self,
        config: Optional[EnvironmentProviderConfig] = None,
        transport: Optional[Transport] = None,
        now: Callable[[], datetime] = _utc_now,
    ) -> None:
        self.config = config or EnvironmentProviderConfig()
        _validate_provider_config(self.config)
        self.transport = transport or _http_transport
        self.now = now
        self._cache: Dict[Tuple[Any, ...], _CacheEntry] = {}

    def _cache_key(self, endpoint: str, params: Dict[str, Any]) -> Tuple[Any, ...]:
        return (endpoint, *tuple(sorted((str(key), str(value)) for key, value in params.items())))

    def _fetch(self, endpoint: str, params: Dict[str, Any]) -> Tuple[Dict[str, Any], str, datetime, Optional[str]]:
        key = self._cache_key(endpoint, params)
        current_time = _aware_utc(self.now())
        cached = self._cache.get(key)
        if cached and current_time - cached.fetched_at <= CACHE_TTLS[endpoint]:
            return cached.value, "available", cached.fetched_at, None
        try:
            value = self.transport(
                self.config,
                endpoint,
                dict(params),
                self.config.timeout_seconds,
                MAX_RESPONSE_BYTES[endpoint],
            )
            if not isinstance(value, dict):
                raise EnvironmentProviderError("provider_invalid_response")
            self._cache[key] = _CacheEntry(value=value, fetched_at=current_time)
            return value, "available", current_time, None
        except EnvironmentProviderError as exc:
            reason = str(exc) or "provider_unavailable"
        except Exception:
            reason = "provider_unavailable"
        if cached:
            return cached.value, "stale", cached.fetched_at, reason
        raise EnvironmentProviderError(reason)

    def search_city(self, query: Any, selected_id: Optional[str] = None) -> Dict[str, Any]:
        city = _bounded_city(query)
        lookup_city, region_hint = _qualified_chinese_city(city)
        params = {"name": lookup_city, "count": 5, "language": "zh", "format": "json"}
        try:
            payload, data_status, fetched_at, stale_reason = self._fetch("geocoding", params)
        except EnvironmentProviderError as exc:
            return {
                "query": city,
                "status": "missing",
                "reason": str(exc),
                "candidates": [],
                "selected": None,
                "provider": "Open-Meteo Geocoding",
            }
        candidates = []
        seen = set()
        raw_results = payload.get("results")
        if isinstance(raw_results, list):
            for raw in raw_results:
                candidate = _normalize_location(raw)
                if candidate and candidate["id"] not in seen:
                    seen.add(candidate["id"])
                    candidates.append(candidate)
        if region_hint:
            region_key = _administrative_key(region_hint)
            candidates = [
                item for item in candidates
                if _administrative_key(item.get("admin1")) == region_key
            ]
        candidates.sort(
            key=lambda item: (
                0 if item["name"].casefold() == lookup_city.casefold() else 1,
                item["country"],
                item["admin1"],
                item["name"],
                item["id"],
            )
        )
        selected = next((item for item in candidates if item["id"] == selected_id), None)
        if selected is None and len(candidates) == 1 and not selected_id:
            selected = candidates[0]
        if selected:
            status = "confirmed"
        elif candidates:
            status = "needs_confirmation"
        else:
            status = "missing"
        result = {
            "query": city,
            "status": status,
            "candidates": candidates,
            "selected": selected,
            "provider": "Open-Meteo Geocoding",
            "fetched_at": fetched_at.isoformat(timespec="seconds"),
            "data_status": data_status,
        }
        if stale_reason:
            result["stale_reason"] = stale_reason
        if status == "missing":
            result["reason"] = "location_not_found"
        elif selected_id and selected is None:
            result["reason"] = "selected_location_no_longer_available"
        return result

    def _forecast(self, place: Dict[str, Any]) -> Dict[str, Any]:
        params = {
            "latitude": place["latitude"],
            "longitude": place["longitude"],
            "timezone": place["timezone"],
            "forecast_hours": 24,
            "current": (
                "temperature_2m,apparent_temperature,relative_humidity_2m,"
                "precipitation,weather_code,wind_speed_10m"
            ),
            "hourly": "temperature_2m,precipitation_probability,weather_code,wind_speed_10m",
        }
        try:
            payload, data_status, fetched_at, reason = self._fetch("forecast", params)
        except EnvironmentProviderError as exc:
            missing = {"status": "missing", "reason": str(exc), "source": "Open-Meteo Forecast"}
            return {"current": dict(missing), "trend_24h": dict(missing)}
        current = payload.get("current") if isinstance(payload.get("current"), dict) else {}
        units = payload.get("current_units") if isinstance(payload.get("current_units"), dict) else {}
        observed_at = str(current.get("time") or "").strip()
        temperature = _display_number(current.get("temperature_2m"))
        if not observed_at or temperature is None:
            current_fact = {
                "status": "missing",
                "reason": "provider_invalid_response",
                "source": "Open-Meteo Forecast",
            }
        else:
            weather_code = _display_number(current.get("weather_code"))
            current_fact = {
                "status": data_status,
                "observed_at": observed_at,
                "last_updated": fetched_at.isoformat(timespec="seconds"),
                "temperature": _unit(current.get("temperature_2m"), units.get("temperature_2m")),
                "apparent_temperature": _unit(
                    current.get("apparent_temperature"), units.get("apparent_temperature")
                ),
                "humidity": _unit(
                    current.get("relative_humidity_2m"), units.get("relative_humidity_2m")
                ),
                "precipitation": _unit(current.get("precipitation"), units.get("precipitation")),
                "wind_speed": _unit(current.get("wind_speed_10m"), units.get("wind_speed_10m")),
                "weather": {
                    "code": weather_code,
                    "label": WEATHER_LABELS.get(weather_code, "未知天气代码"),
                },
                "source": "Open-Meteo Forecast",
            }
            if reason:
                current_fact["stale_reason"] = reason

        hourly = payload.get("hourly") if isinstance(payload.get("hourly"), dict) else {}
        times = hourly.get("time") if isinstance(hourly.get("time"), list) else []
        temperatures = hourly.get("temperature_2m") if isinstance(hourly.get("temperature_2m"), list) else []
        rain = hourly.get("precipitation_probability") if isinstance(hourly.get("precipitation_probability"), list) else []
        codes = hourly.get("weather_code") if isinstance(hourly.get("weather_code"), list) else []
        winds = hourly.get("wind_speed_10m") if isinstance(hourly.get("wind_speed_10m"), list) else []
        hours = []
        for index, time_value in enumerate(times[:24]):
            hours.append(
                {
                    "time": str(time_value),
                    "temperature": _display_number(temperatures[index]) if index < len(temperatures) else None,
                    "rain_probability": _display_number(rain[index]) if index < len(rain) else None,
                    "weather_code": _display_number(codes[index]) if index < len(codes) else None,
                    "wind_speed": _display_number(winds[index]) if index < len(winds) else None,
                }
            )
        trend = {
            "status": data_status if hours else "missing",
            "hours": hours,
            "last_updated": fetched_at.isoformat(timespec="seconds"),
            "source": "Open-Meteo Forecast",
            "units": payload.get("hourly_units") if isinstance(payload.get("hourly_units"), dict) else {},
        }
        if not hours:
            trend["reason"] = "provider_invalid_response"
        elif reason:
            trend["stale_reason"] = reason
        return {"current": current_fact, "trend_24h": trend}

    def _air_quality(self, place: Dict[str, Any]) -> Dict[str, Any]:
        params = {
            "latitude": place["latitude"],
            "longitude": place["longitude"],
            "timezone": place["timezone"],
            "current": "us_aqi,pm2_5",
        }
        try:
            payload, data_status, fetched_at, reason = self._fetch("air_quality", params)
        except EnvironmentProviderError as exc:
            return {"status": "missing", "reason": str(exc), "source": "Open-Meteo Air Quality"}
        current = payload.get("current") if isinstance(payload.get("current"), dict) else {}
        units = payload.get("current_units") if isinstance(payload.get("current_units"), dict) else {}
        if _number(current.get("us_aqi")) is None and _number(current.get("pm2_5")) is None:
            return {
                "status": "missing",
                "reason": "provider_invalid_response",
                "source": "Open-Meteo Air Quality",
            }
        result = {
            "status": data_status,
            "observed_at": str(current.get("time") or ""),
            "last_updated": fetched_at.isoformat(timespec="seconds"),
            "aqi": _unit(current.get("us_aqi"), units.get("us_aqi")),
            "pm2_5": _unit(current.get("pm2_5"), units.get("pm2_5")),
            "source": "Open-Meteo Air Quality",
        }
        if reason:
            result["stale_reason"] = reason
        return result

    def _baseline(self, place: Dict[str, Any]) -> Dict[str, Any]:
        local_today = _aware_utc(self.now()).astimezone(ZoneInfo(place["timezone"])).date()
        end = local_today - timedelta(days=5)
        start = end - timedelta(days=29)
        params = {
            "latitude": place["latitude"],
            "longitude": place["longitude"],
            "timezone": place["timezone"],
            "start_date": start.isoformat(),
            "end_date": end.isoformat(),
            "daily": "temperature_2m_mean,precipitation_sum,wind_speed_10m_max",
        }
        try:
            payload, data_status, fetched_at, reason = self._fetch("historical", params)
        except EnvironmentProviderError as exc:
            return {"status": "missing", "reason": str(exc), "source": "Open-Meteo Historical Weather"}
        daily = payload.get("daily") if isinstance(payload.get("daily"), dict) else {}
        units = payload.get("daily_units") if isinstance(payload.get("daily_units"), dict) else {}
        dates = daily.get("time") if isinstance(daily.get("time"), list) else []
        temperatures = daily.get("temperature_2m_mean") if isinstance(daily.get("temperature_2m_mean"), list) else []
        valid_temperatures = [value for value in temperatures if _number(value) is not None]
        coverage = len(valid_temperatures) / len(dates) if dates else 0
        if coverage < 0.7:
            return {
                "status": "missing",
                "reason": "insufficient_coverage",
                "coverage": round(coverage, 2),
                "source": "Open-Meteo Historical Weather",
            }
        result = {
            "status": data_status,
            "label": "近 30 日环境基线",
            "sample_period": {"start": str(dates[0]), "end": str(dates[-1])},
            "sample_years": sorted({str(value)[:4] for value in dates if str(value)[:4].isdigit()}),
            "coverage": round(coverage, 2),
            "temperature_mean": _unit(_mean(temperatures), units.get("temperature_2m_mean")),
            "precipitation_daily_mean": _unit(
                _mean(daily.get("precipitation_sum") or []), units.get("precipitation_sum")
            ),
            "wind_max_daily_mean": _unit(
                _mean(daily.get("wind_speed_10m_max") or []), units.get("wind_speed_10m_max")
            ),
            "last_updated": fetched_at.isoformat(timespec="seconds"),
            "source": "Open-Meteo Historical Weather",
        }
        if reason:
            result["stale_reason"] = reason
        return result

    def _facts(self, locations: Dict[str, Any], environment: Dict[str, Any]) -> list:
        facts = []
        for role in ("birth", "current"):
            selected = locations[role].get("selected")
            facts.append(
                {
                    "id": "location.{}".format(role),
                    "type": "normalized_location",
                    "value": selected,
                    "source": "Open-Meteo Geocoding",
                    "status": "available" if selected else locations[role]["status"],
                }
            )
        current = environment.get("current") or {}
        air = environment.get("air_quality") or {}
        baseline = environment.get("baseline") or {}
        facts.extend(
            [
                {
                    "id": "environment.weather.current",
                    "type": "environment_observation",
                    "value": current if current.get("status") in {"available", "stale"} else None,
                    "source": current.get("source", "Open-Meteo Forecast"),
                    "status": current.get("status", "missing"),
                },
                {
                    "id": "environment.air_quality.current",
                    "type": "environment_observation",
                    "value": air if air.get("status") in {"available", "stale"} else None,
                    "source": air.get("source", "Open-Meteo Air Quality"),
                    "status": air.get("status", "missing"),
                },
                {
                    "id": "environment.baseline.recent",
                    "type": "environment_baseline",
                    "value": baseline if baseline.get("status") in {"available", "stale"} else None,
                    "source": baseline.get("source", "Open-Meteo Historical Weather"),
                    "status": baseline.get("status", "missing"),
                },
            ]
        )
        return facts

    def build_snapshot(
        self,
        birth_city: Any,
        current_city: Any,
        *,
        birth_location_id: Optional[str] = None,
        current_location_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        birth = self.search_city(birth_city, selected_id=birth_location_id)
        current = self.search_city(current_city, selected_id=current_location_id)
        locations = {"birth": birth, "current": current}
        selected = current.get("selected")
        if not selected:
            reason = (
                "current_location_needs_confirmation"
                if current.get("status") == "needs_confirmation"
                else "current_location_missing"
            )
            environment = {
                "status": "missing",
                "reason": reason,
                "location": None,
                "current": {"status": "missing", "reason": reason},
                "trend_24h": {"status": "missing", "reason": reason},
                "air_quality": {"status": "missing", "reason": reason},
                "baseline": {"status": "missing", "reason": reason},
            }
            overall_status = "awaiting_confirmation" if "confirmation" in reason else "partial"
        else:
            forecast = self._forecast(selected)
            environment = {
                "status": "available",
                "location": selected,
                "current": forecast["current"],
                "trend_24h": forecast["trend_24h"],
                "air_quality": self._air_quality(selected),
                "baseline": self._baseline(selected),
            }
            statuses = {
                environment[key].get("status")
                for key in ("current", "trend_24h", "air_quality", "baseline")
            }
            if birth.get("status") != "confirmed" or statuses != {"available"}:
                overall_status = "partial"
                environment["status"] = "partial"
            else:
                overall_status = "complete"
        snapshot = {
            "version": ENVIRONMENT_VERSION,
            "status": overall_status,
            "provider": {
                "name": self.config.provider_name,
                "attribution": "Weather data by Open-Meteo.com",
                "terms_url": "https://open-meteo.com/en/terms",
            },
            "fetched_at": _aware_utc(self.now()).isoformat(timespec="seconds"),
            "locations": locations,
            "environment": environment,
        }
        snapshot["facts"] = self._facts(locations, environment)
        return snapshot


DEFAULT_ENVIRONMENT_GATEWAY = EnvironmentGateway()
